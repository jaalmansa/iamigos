"""Tests for the Claude Code hook (hooks/iamigos-hook).

Each test runs the real script as Claude Code would: event JSON on stdin, a
throwaway XDG_STATE_HOME, and then checks the session file it wrote.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(ROOT, "hooks", "iamigos-hook")
SID = "test-session"


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "state")
        self.transcript = os.path.join(self.tmp.name, "transcript.jsonl")
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(("ZELLIJ", "TMUX"))}
        self.env["XDG_STATE_HOME"] = self.state

    def tearDown(self):
        self.tmp.cleanup()

    def emit(self, event, env=None, raw=None, **fields):
        payload = raw if raw is not None else json.dumps({
            "session_id": SID, "cwd": "/home/me/project",
            "transcript_path": self.transcript, "hook_event_name": event, **fields,
        })
        result = subprocess.run([sys.executable, HOOK], input=payload, text=True,
                                capture_output=True, env={**self.env, **(env or {})})
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "", "the hook must never print to stdout")
        return result

    @property
    def path(self):
        return os.path.join(self.state, "iamigos", "sessions", f"claude-{SID}.json")

    def session(self):
        with open(self.path) as f:
            return json.load(f)

    def write_transcript(self, *entries):
        with open(self.transcript, "w") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")

    # --- states ---------------------------------------------------------------

    def test_session_start_is_idle(self):
        self.emit("SessionStart", source="startup")
        s = self.session()
        self.assertEqual(s["state"], "idle")
        self.assertEqual(s["project"], "project")
        self.assertEqual(s["agent"], "claude")

    def test_states_follow_the_events(self):
        cases = [
            ("UserPromptSubmit", {}, "working", ""),
            ("PreToolUse", {"tool_name": "Bash"}, "working", "Bash"),
            ("PreToolUse", {"tool_name": "AskUserQuestion"}, "asking", "AskUserQuestion"),
            ("PermissionRequest", {"tool_name": "Edit"}, "permission", "Edit"),
            ("Notification", {"notification_type": "permission_prompt", "message": "ok?"}, "permission", "ok?"),
            ("Notification", {"notification_type": "elicitation_dialog", "message": "pick"}, "asking", "pick"),
            ("PreCompact", {"trigger": "auto"}, "compacting", "auto"),
            ("Stop", {}, "done", ""),
            ("StopFailure", {"error": "overloaded"}, "error", "overloaded"),
            ("SessionEnd", {"reason": "exit"}, "closed", "exit"),
        ]
        for event, fields, state, detail in cases:
            with self.subTest(event=event, fields=fields):
                self.emit(event, **fields)
                s = self.session()
                self.assertEqual(s["state"], state)
                self.assertEqual(s["detail"], detail)

    def test_events_that_change_nothing_write_nothing(self):
        self.emit("Notification", notification_type="idle_prompt")
        self.assertFalse(os.path.exists(self.path))

    def test_since_only_moves_when_the_state_changes(self):
        self.emit("UserPromptSubmit")
        first = self.session()["since"]
        self.emit("PreToolUse", tool_name="Read")
        self.assertEqual(self.session()["since"], first)
        self.emit("Stop")
        self.assertGreaterEqual(self.session()["since"], first)

    # --- turn and context -----------------------------------------------------

    def test_turn_starts_with_the_prompt_and_ends_with_stop(self):
        self.emit("UserPromptSubmit")
        s = self.session()
        self.assertIsNotNone(s["turn_started"])
        self.assertIsNone(s["turn_ended"])
        self.emit("Stop")
        s = self.session()
        self.assertGreaterEqual(s["turn_ended"], s["turn_started"])

    def test_context_comes_from_the_last_main_agent_response(self):
        usage = {"input_tokens": 10, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200}
        self.write_transcript(
            {"type": "assistant", "message": {"model": "claude-old", "usage": {"input_tokens": 1}}},
            {"type": "assistant", "message": {"model": "claude-main", "usage": usage}},
            {"type": "assistant", "isSidechain": True,
             "message": {"model": "claude-sub", "usage": {"input_tokens": 99999}}},
        )
        self.emit("Stop")
        s = self.session()
        self.assertEqual(s["tokens"], 1210)
        self.assertEqual(s["model"], "claude-main")

    def test_compaction_forgets_the_context_size(self):
        self.write_transcript({"type": "assistant", "message": {"usage": {"input_tokens": 500}}})
        self.emit("Stop")
        self.assertEqual(self.session()["tokens"], 500)
        self.emit("PostCompact")
        self.assertIsNone(self.session()["tokens"])

    def test_missing_transcript_is_not_an_error(self):
        self.emit("Stop", transcript_path="/nonexistent/transcript.jsonl")
        self.assertIsNone(self.session()["tokens"])

    # --- subagents ------------------------------------------------------------

    def test_subagents_are_added_and_removed(self):
        self.emit("UserPromptSubmit")
        self.emit("SubagentStart", agent_id="a1", agent_type="Explore")
        self.emit("SubagentStart", agent_id="a2", agent_type="Plan")
        self.emit("SubagentStart", agent_id="a1", agent_type="Explore")   # repeated
        self.assertEqual([x["type"] for x in self.session()["subagents"]], ["Explore", "Plan"])
        self.emit("SubagentStop", agent_id="a1")
        self.assertEqual([x["id"] for x in self.session()["subagents"]], ["a2"])
        self.emit("SessionEnd")
        self.assertEqual(self.session()["subagents"], [])

    def test_subagent_stop_does_not_create_a_session(self):
        self.emit("SubagentStop", agent_id="a1")
        self.assertFalse(os.path.exists(self.path))

    # --- multiplexers ---------------------------------------------------------

    def test_records_the_zellij_pane(self):
        self.emit("SessionStart", env={"ZELLIJ_SESSION_NAME": "work", "ZELLIJ_PANE_ID": "3"})
        self.assertEqual(self.session()["mux"], {"kind": "zellij", "session": "work", "pane": "3"})

    def test_records_the_tmux_pane(self):
        self.emit("SessionStart", env={"TMUX": "/tmp/tmux-1000/default,123,0", "TMUX_PANE": "%7"})
        self.assertEqual(self.session()["mux"], {"kind": "tmux", "socket": "/tmp/tmux-1000/default", "pane": "%7"})

    def test_plain_terminal_has_no_mux(self):
        self.emit("SessionStart")
        self.assertIsNone(self.session()["mux"])

    # --- robustness -----------------------------------------------------------

    def test_never_breaks_on_bad_input(self):
        for raw in ["", "not json", "[]", '{"hook_event_name": "Stop"}']:
            with self.subTest(raw=raw):
                self.emit("Stop", raw=raw)

    def test_leaves_no_temporary_files(self):
        self.emit("SessionStart")
        self.emit("Stop")
        leftovers = [f for f in os.listdir(os.path.dirname(self.path)) if f.endswith(".tmp")]
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
