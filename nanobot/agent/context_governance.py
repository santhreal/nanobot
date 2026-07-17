"""Model-message governance for agent runner requests.

This module owns model-facing message shaping and tool-result content normalization.
It may return copied messages or persisted-result placeholders, but it must not
mutate an existing session history list in place.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from nanobot.utils.helpers import (
    estimate_message_tokens,
    estimate_prompt_tokens_chain,
    find_legal_message_start,
    maybe_persist_tool_result,
    truncate_text,
)
from nanobot.utils.runtime import ensure_nonempty_tool_result, with_tool_error_recovery_hint

if TYPE_CHECKING:
    from nanobot.providers.base import LLMProvider

SNIP_SAFETY_BUFFER = 1024
MICROCOMPACT_KEEP_RECENT = 10
MICROCOMPACT_MIN_CHARS = 500
INFLIGHT_COMPACT_TARGET_RATIO = 0.85
COMPACTABLE_TOOLS = frozenset({
    "read_file", "exec", "grep", "find_files",
    "web_search", "web_fetch", "list_dir", "list_exec_sessions",
})
# read_file is the recovery path for persisted results; exempting it prevents persist->read->persist loops.
TOOL_RESULT_OFFLOAD_EXEMPT_TOOLS = frozenset({"read_file"})
BACKFILL_CONTENT = "[Tool result unavailable — call was interrupted or lost]"
PLACEHOLDER_TEXTS = frozenset({
    "[Previous assistant message omitted.]",
})
CONTEXT_OVERFLOW_TOOL_RESULT_ERROR = (
    "Error: The result from `{tool_name}` was too large to fit in the available model "
    "context, so its content was omitted. Do not repeat the same call unchanged. Try a "
    "narrower query, request fewer results, read a smaller range, or use another approach."
)


def _tool_call_name_is_valid(tool_call: Any) -> bool:
    """Whether a persisted OpenAI-style tool_call carries a usable name.

    Mirrors ``ToolCallRequest.has_valid_name`` for the dict shape stored in
    message history: a degenerate call with ``name=None`` / ``""`` cannot be
    executed and is rejected by upstream APIs if replayed.
    """
    if not isinstance(tool_call, dict):
        return False
    fn = tool_call.get("function")
    name = fn.get("name") if isinstance(fn, dict) else tool_call.get("name")
    return isinstance(name, str) and bool(name)


@dataclass(slots=True)
class ContextGovernanceConfig:
    provider: LLMProvider
    model: str
    tools: Any
    workspace: Path | None
    session_key: str | None
    max_tool_result_chars: int
    context_window_tokens: int | None = None
    context_block_limit: int | None = None
    max_tokens: int | None = None
    inflight_start_index: int = 0


@dataclass(slots=True)
class ContextOverflowRecovery:
    """Model and canonical message copies after a confirmed provider overflow."""

    model_messages: list[dict[str, Any]]
    canonical_messages: list[dict[str, Any]]


class ContextGovernor:
    """Prepare model-copy messages while preserving persisted history."""

    def prepare_for_model(
        self,
        config: ContextGovernanceConfig,
        messages: list[dict[str, Any]],
        compacted_tool_result_indexes: set[int],
    ) -> list[dict[str, Any]]:
        updated = self.strip_placeholder_assistant_messages(messages)
        updated = self.strip_malformed_tool_calls(updated)
        updated = self.drop_orphan_tool_results(updated)
        updated = self.backfill_missing_tool_results(updated)
        updated = self.apply_tool_result_budget(config, updated)
        updated = self.compact_inflight_overflow(
            config,
            updated,
            compacted_tool_result_indexes,
            canonical_messages=messages,
        )
        updated = self.snip_history(config, updated)
        updated = self.drop_orphan_tool_results(updated)
        return self.backfill_missing_tool_results(updated)

    @staticmethod
    def input_budget(config: ContextGovernanceConfig) -> int:
        if not config.context_window_tokens:
            return 0

        provider_max_tokens = getattr(
            getattr(config.provider, "generation", None),
            "max_tokens",
            4096,
        )
        max_output = config.max_tokens if isinstance(config.max_tokens, int) else (
            provider_max_tokens if isinstance(provider_max_tokens, int) else 4096
        )
        budget = config.context_block_limit or (
            config.context_window_tokens - max_output - SNIP_SAFETY_BUFFER
        )
        return budget if budget > 0 else 0

    @staticmethod
    def normalize_tool_result(
        config: ContextGovernanceConfig,
        tool_call_id: str,
        tool_name: str,
        result: Any,
    ) -> Any:
        result = ensure_nonempty_tool_result(tool_name, result)
        if tool_name in TOOL_RESULT_OFFLOAD_EXEMPT_TOOLS:
            return result
        try:
            content = maybe_persist_tool_result(
                config.workspace,
                config.session_key,
                tool_call_id,
                result,
                max_chars=config.max_tool_result_chars,
            )
        except Exception:
            logger.exception(
                "Tool result persist failed for {} in {}; using raw result",
                tool_call_id,
                config.session_key or "default",
            )
            content = result
        if isinstance(content, str) and len(content) > config.max_tool_result_chars:
            return truncate_text(content, config.max_tool_result_chars)
        return content

    @staticmethod
    def strip_placeholder_assistant_messages(
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Remove assistant messages that are compaction placeholders.

        Messages like ``[Previous assistant message omitted.]`` carry no useful
        context for the model and can cause it to repeatedly attempt tool calls
        that previously failed, producing malformed responses in a loop.
        Consecutive same-role messages that result from removal are handled
        downstream by the provider's merge-consecutive logic. Only the
        model-facing copy is repaired; the persisted transcript is untouched
        (a copy is returned, or the same list object when nothing changes).
        """
        updated: list[dict[str, Any]] | None = None
        for idx, msg in enumerate(messages):
            if msg.get("role") != "assistant":
                if updated is not None:
                    updated.append(msg)
                continue
            content = msg.get("content", "")
            text = content if isinstance(content, str) else ""
            is_placeholder = text.strip() in PLACEHOLDER_TEXTS
            has_tool_calls = bool(msg.get("tool_calls"))
            if is_placeholder and not has_tool_calls:
                if updated is None:
                    updated = list(messages[:idx])
                logger.debug(
                    "Stripping placeholder assistant message from history: {!r}",
                    text[:60],
                )
                continue
            if updated is not None:
                updated.append(msg)
        if updated is None:
            return messages
        return updated

    @staticmethod
    def strip_malformed_tool_calls(
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Drop persisted assistant tool_calls whose name is missing/non-string.

        A degenerate tool call (``name=None`` or ``""``) that slipped into the
        saved history before this guard existed gets replayed on every turn and
        makes upstream APIs reject the whole request
        (``messages.content.N.tool_use.name: Input should be a valid string``),
        permanently wedging the session. Removing the bad call here lets the
        existing orphan-result cleanup drop its now-dangling tool result, so a
        polluted session self-heals on its next turn. The persisted transcript
        is left untouched; only the model-facing copy is repaired (a copy is
        returned, or the same list object when nothing changes).
        """
        updated: list[dict[str, Any]] | None = None
        for idx, msg in enumerate(messages):
            if msg.get("role") != "assistant":
                if updated is not None:
                    updated.append(msg)
                continue
            calls = msg.get("tool_calls")
            if not calls:
                if updated is not None:
                    updated.append(msg)
                continue
            kept = [tc for tc in calls if _tool_call_name_is_valid(tc)]
            if len(kept) == len(calls):
                if updated is not None:
                    updated.append(msg)
                continue
            if updated is None:
                updated = [dict(m) for m in messages[:idx]]
            logger.warning(
                "Stripping {} malformed tool_call(s) with missing/non-string "
                "name from assistant history before request",
                len(calls) - len(kept),
            )
            repaired = dict(msg)
            if kept:
                repaired["tool_calls"] = kept
            else:
                repaired.pop("tool_calls", None)
            # An assistant turn with neither content nor any valid tool call is
            # itself invalid upstream; drop it entirely in that case.
            has_content = bool(repaired.get("content"))
            if not kept and not has_content:
                continue
            updated.append(repaired)

        if updated is None:
            return messages
        return updated

    @staticmethod
    def drop_orphan_tool_results(
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Drop tool results that have no matching assistant tool_call earlier in history."""
        declared: set[str] = set()
        updated: list[dict[str, Any]] | None = None
        for idx, msg in enumerate(messages):
            role = msg.get("role")
            if role == "assistant":
                for tc in msg.get("tool_calls") or []:
                    if isinstance(tc, dict) and tc.get("id"):
                        declared.add(str(tc["id"]))
            if role == "tool":
                tid = msg.get("tool_call_id")
                if tid and str(tid) not in declared:
                    if updated is None:
                        updated = [dict(m) for m in messages[:idx]]
                    continue
            if updated is not None:
                updated.append(dict(msg))

        if updated is None:
            return messages
        return updated

    @staticmethod
    def backfill_missing_tool_results(
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Insert synthetic error results for assistant tool_calls with missing tool outputs."""
        declared: list[tuple[int, str, str]] = []
        fulfilled: set[str] = set()
        for idx, msg in enumerate(messages):
            role = msg.get("role")
            if role == "assistant":
                for tc in msg.get("tool_calls") or []:
                    if isinstance(tc, dict) and tc.get("id"):
                        name = ""
                        func = tc.get("function")
                        if isinstance(func, dict):
                            name = func.get("name", "")
                        declared.append((idx, str(tc["id"]), name))
            elif role == "tool":
                tid = msg.get("tool_call_id")
                if tid:
                    fulfilled.add(str(tid))

        missing = [(ai, cid, name) for ai, cid, name in declared if cid not in fulfilled]
        if not missing:
            return messages

        updated = list(messages)
        offset = 0
        for assistant_idx, call_id, name in missing:
            insert_at = assistant_idx + 1 + offset
            while insert_at < len(updated) and updated[insert_at].get("role") == "tool":
                insert_at += 1
            updated.insert(insert_at, {
                "role": "tool",
                "tool_call_id": call_id,
                "name": name,
                "content": BACKFILL_CONTENT,
            })
            offset += 1
        return updated

    def apply_tool_result_budget(
        self,
        config: ContextGovernanceConfig,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        updated = messages
        for idx, message in enumerate(messages):
            if message.get("role") != "tool":
                continue
            normalized = self.normalize_tool_result(
                config,
                str(message.get("tool_call_id") or f"tool_{idx}"),
                str(message.get("name") or "tool"),
                message.get("content"),
            )
            if normalized != message.get("content"):
                if updated is messages:
                    updated = [dict(m) for m in messages]
                updated[idx]["content"] = normalized
        return updated

    def compact_inflight_overflow(
        self,
        config: ContextGovernanceConfig,
        messages: list[dict[str, Any]],
        compacted_tool_result_indexes: set[int],
        *,
        canonical_messages: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """Compact in-flight tool results only when the request would overflow."""
        if canonical_messages is None:
            canonical_messages = messages
        updated = self._apply_recorded_compactions(
            canonical_messages,
            messages,
            compacted_tool_result_indexes,
        )
        budget = self.input_budget(config)
        if budget <= 0:
            return updated

        tools = config.tools.get_definitions()
        estimate, source = estimate_prompt_tokens_chain(
            config.provider,
            config.model,
            updated,
            tools,
        )
        if estimate <= budget:
            return updated

        target = int(budget * INFLIGHT_COMPACT_TARGET_RATIO)
        candidates = self._inflight_compaction_candidates(
            config,
            canonical_messages,
            updated,
            compacted_tool_result_indexes,
        )
        if not candidates:
            return updated

        for candidate_idx, (idx, canonical_idx) in enumerate(candidates):
            is_newest_candidate = candidate_idx == len(candidates) - 1
            if is_newest_candidate and estimate <= budget:
                break
            if canonical_idx in compacted_tool_result_indexes:
                continue
            if updated is messages:
                updated = [dict(m) for m in messages]
            compacted_tool_result_indexes.add(canonical_idx)
            self._compact_tool_result_at(updated, idx)
            estimate, source = estimate_prompt_tokens_chain(
                config.provider,
                config.model,
                updated,
                tools,
            )
            if estimate <= target:
                break

        logger.debug(
            "In-flight context compaction for {}: prompt={} budget={} target={} via {}, results={}",
            config.session_key or "default",
            estimate,
            budget,
            target,
            source,
            len(compacted_tool_result_indexes),
        )
        return updated

    def recover_provider_overflow(
        self,
        config: ContextGovernanceConfig,
        messages: list[dict[str, Any]],
        prepared_messages: list[dict[str, Any]],
        compacted_tool_result_indexes: set[int],
    ) -> ContextOverflowRecovery | None:
        """Replace the largest current-turn result after a provider overflow.

        Both returned lists preserve the assistant/tool pairing. The model copy is used for the
        immediate retry, while the canonical copy keeps the confirmed replacement across turns.
        The input lists remain untouched.
        """
        candidates: list[tuple[int, int, int, dict[str, Any]]] = []
        for canonical_idx in range(config.inflight_start_index, len(messages)):
            canonical_message = messages[canonical_idx]
            if canonical_message.get("role") != "tool" or not canonical_message.get("tool_call_id"):
                continue
            prepared_idx = self._matching_tool_result_index(
                messages,
                prepared_messages,
                canonical_idx,
            )
            if prepared_idx is None:
                continue
            prepared_message = prepared_messages[prepared_idx]
            candidates.append((
                len(str(prepared_message.get("content") or "")),
                canonical_idx,
                prepared_idx,
                prepared_message,
            ))
        if not candidates:
            return None

        original_chars, canonical_idx, prepared_idx, message = max(
            candidates,
            key=lambda candidate: candidate[0],
        )
        hint = with_tool_error_recovery_hint(
            CONTEXT_OVERFLOW_TOOL_RESULT_ERROR.format(
                tool_name=str(message.get("name") or "tool"),
            )
        )
        replacement = dict(message, content=hint)
        if len(hint) >= original_chars:
            return None

        canonical_messages = [dict(item) for item in messages]
        canonical_messages[canonical_idx] = dict(
            canonical_messages[canonical_idx],
            content=hint,
        )

        compacted_tool_result_indexes.add(canonical_idx)
        model_messages = [dict(item) for item in prepared_messages]
        model_messages[prepared_idx] = replacement
        return ContextOverflowRecovery(
            model_messages=model_messages,
            canonical_messages=canonical_messages,
        )

    def snip_history(
        self,
        config: ContextGovernanceConfig,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not messages or not config.context_window_tokens:
            return messages

        budget = self.input_budget(config)
        if budget <= 0:
            return messages

        tools = config.tools.get_definitions()
        estimate, _ = estimate_prompt_tokens_chain(
            config.provider,
            config.model,
            messages,
            tools,
        )
        if estimate <= budget:
            return messages

        system_messages = [dict(msg) for msg in messages if msg.get("role") == "system"]
        non_system = [dict(msg) for msg in messages if msg.get("role") != "system"]
        if not non_system:
            return messages

        system_tokens = sum(estimate_message_tokens(msg) for msg in system_messages)
        fixed_tokens, _ = estimate_prompt_tokens_chain(
            config.provider,
            config.model,
            system_messages,
            tools,
        )
        remaining_budget = max(0, budget - max(system_tokens, fixed_tokens))
        kept: list[dict[str, Any]] = []
        kept_tokens = 0
        for message in reversed(non_system):
            msg_tokens = estimate_message_tokens(message)
            if kept and kept_tokens + msg_tokens > remaining_budget:
                break
            kept.append(message)
            kept_tokens += msg_tokens
        kept.reverse()

        return system_messages + self._legal_history_tail(kept, non_system)

    @staticmethod
    def _summary_for(message: dict[str, Any]) -> str:
        name = message.get("name", "tool")
        return f"[Prior {name} result compacted to fit context; the tool call already completed.]"

    def _legal_history_tail(
        self,
        kept: list[dict[str, Any]],
        non_system: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        fallback = kept if kept else (non_system[-1:] if non_system else [])
        kept = self._user_tail(kept) or self._user_tail(non_system, last=True) or fallback

        start = find_legal_message_start(kept)
        return kept[start:] if start else kept

    @staticmethod
    def _user_tail(messages: list[dict[str, Any]], *, last: bool = False) -> list[dict[str, Any]]:
        indexes = range(len(messages) - 1, -1, -1) if last else range(len(messages))
        for idx in indexes:
            if messages[idx].get("role") == "user":
                return messages[idx:]
        return []

    def _apply_recorded_compactions(
        self,
        canonical_messages: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        compacted_tool_result_indexes: set[int],
    ) -> list[dict[str, Any]]:
        if not compacted_tool_result_indexes:
            return messages
        updated = messages
        for canonical_idx in sorted(compacted_tool_result_indexes):
            idx = self._matching_tool_result_index(
                canonical_messages,
                messages,
                canonical_idx,
            )
            if idx is None:
                continue
            msg = messages[idx]
            summary = self._summary_for(msg)
            if msg.get("content") == summary:
                continue
            if updated is messages:
                updated = [dict(m) for m in messages]
            updated[idx]["content"] = summary
        return updated

    def _inflight_compaction_candidates(
        self,
        config: ContextGovernanceConfig,
        canonical_messages: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        compacted_tool_result_indexes: set[int],
    ) -> list[tuple[int, int]]:
        compactable: list[tuple[int, int]] = []
        for canonical_idx in range(config.inflight_start_index, len(canonical_messages)):
            msg = canonical_messages[canonical_idx]
            if msg.get("role") != "tool" or msg.get("name") not in COMPACTABLE_TOOLS:
                continue
            tool_call_id = msg.get("tool_call_id")
            if not tool_call_id or canonical_idx in compacted_tool_result_indexes:
                continue
            idx = self._matching_tool_result_index(
                canonical_messages,
                messages,
                canonical_idx,
            )
            if idx is None:
                continue
            content = messages[idx].get("content")
            if not isinstance(content, str) or len(content) < MICROCOMPACT_MIN_CHARS:
                continue
            compactable.append((idx, canonical_idx))

        if not compactable:
            return []
        primary_count = max(0, len(compactable) - MICROCOMPACT_KEEP_RECENT)
        primary = compactable[:primary_count]
        # Hard overflow beats the keep-recent preference. Return recent results
        # after stale ones so the newest result is naturally last.
        fallback = compactable[primary_count:]
        return primary + fallback

    @staticmethod
    def _matching_tool_result_index(
        canonical_messages: list[dict[str, Any]],
        model_messages: list[dict[str, Any]],
        canonical_idx: int,
    ) -> int | None:
        """Map one canonical tool-result occurrence to its model-copy occurrence.

        Governance may remove older history before this lookup, so absolute indexes do not
        remain aligned. Matching the same tool-call ID from the end preserves the identity of
        the current-turn occurrence even when an earlier turn reused that ID.
        """
        if canonical_idx < 0 or canonical_idx >= len(canonical_messages):
            return None
        canonical_message = canonical_messages[canonical_idx]
        if canonical_message.get("role") != "tool":
            return None
        tool_call_id = canonical_message.get("tool_call_id")
        if not tool_call_id:
            return None
        normalized_id = str(tool_call_id)
        later_occurrences = sum(
            1
            for message in canonical_messages[canonical_idx + 1:]
            if message.get("role") == "tool"
            and str(message.get("tool_call_id") or "") == normalized_id
        )
        matching_indexes = [
            idx
            for idx, message in enumerate(model_messages)
            if message.get("role") == "tool"
            and str(message.get("tool_call_id") or "") == normalized_id
        ]
        matching_position = len(matching_indexes) - later_occurrences - 1
        if matching_position < 0:
            return None
        return matching_indexes[matching_position]

    def _compact_tool_result_at(self, messages: list[dict[str, Any]], idx: int) -> None:
        messages[idx]["content"] = self._summary_for(messages[idx])
