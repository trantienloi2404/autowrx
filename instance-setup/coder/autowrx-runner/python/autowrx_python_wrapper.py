#!/usr/bin/env python3

import argparse
import json
import os
import runpy
import sys
from types import FrameType
from typing import Any, Dict, List


MAX_DEPTH = 3
MAX_ITEMS = 50


def sanitize_value(value: Any, depth: int = 0) -> Any:
    if depth >= MAX_DEPTH:
        return "<max-depth>"

    if isinstance(value, (str, int, float, bool)) or value is None:
        return value

    if isinstance(value, (list, tuple)):
        return [sanitize_value(v, depth + 1) for v in list(value)[:MAX_ITEMS]]

    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        count = 0
        for key, item in value.items():
            if count >= MAX_ITEMS:
                break
            out[str(key)] = sanitize_value(item, depth + 1)
            count += 1
        return out

    return repr(value)


class VarsEmitter:
    def __init__(self, script_path: str, vars_out_path: str, control_in_path: str = ""):
        self.script_path = os.path.abspath(script_path)
        self.vars_out_path = vars_out_path
        self.control_in_path = os.path.abspath(control_in_path) if control_in_path else ""
        self.last_payload = None
        self.control_offset = 0
        self.control_residue = ""
        os.makedirs(os.path.dirname(vars_out_path), exist_ok=True)
        self.stream = open(vars_out_path, "a", encoding="utf-8", buffering=1)
        if self.control_in_path:
            os.makedirs(os.path.dirname(self.control_in_path), exist_ok=True)
            open(self.control_in_path, "a", encoding="utf-8").close()

    def close(self) -> None:
        try:
            self.stream.close()
        except Exception:
            pass

    def emit(self, frame: FrameType) -> None:
        filename = os.path.abspath(frame.f_code.co_filename or "")
        if filename != self.script_path:
            return

        raw_locals = frame.f_locals or {}
        vars_payload: Dict[str, Any] = {}
        for name, value in raw_locals.items():
            if name.startswith("__"):
                continue
            vars_payload[name] = sanitize_value(value)

        payload = {
            "type": "vars.snapshot",
            "vars": vars_payload,
            "frame": {
                "file": filename,
                "line": int(getattr(frame, "f_lineno", 0) or 0),
                "function": str(frame.f_code.co_name or ""),
            },
        }

        if payload == self.last_payload:
            return
        self.last_payload = payload
        self.stream.write(json.dumps(payload, ensure_ascii=True) + "\n")

    def read_control_commands(self) -> List[Dict[str, Any]]:
        if not self.control_in_path:
            return []
        try:
            stats = os.stat(self.control_in_path)
        except OSError:
            return []
        if stats.st_size <= self.control_offset:
            return []
        try:
            with open(self.control_in_path, "r", encoding="utf-8") as handle:
                handle.seek(self.control_offset)
                chunk = handle.read()
                self.control_offset = handle.tell()
        except OSError:
            return []
        if not chunk:
            return []
        joined = f"{self.control_residue}{chunk}"
        lines = joined.splitlines()
        if joined and not joined.endswith("\n"):
            self.control_residue = lines.pop() if lines else joined
        else:
            self.control_residue = ""
        commands: List[Dict[str, Any]] = []
        for line in lines:
            text = line.strip()
            if not text:
                continue
            try:
                cmd = json.loads(text)
                if isinstance(cmd, dict):
                    commands.append(cmd)
            except json.JSONDecodeError:
                continue
        return commands

    def apply_control_commands(self, frame: FrameType) -> None:
        commands = self.read_control_commands()
        if not commands:
            return
        for cmd in commands:
            if cmd.get("type") != "set_value":
                continue
            name = str(cmd.get("name") or "").strip()
            if not name:
                continue
            value = cmd.get("value")
            frame.f_globals[name] = value
            frame.f_locals[name] = value

    def tracer(self, frame: FrameType, event: str, arg: Any):
        if event == "line":
            self.apply_control_commands(frame)
            self.emit(frame)
        return self.tracer


def main() -> int:
    parser = argparse.ArgumentParser(description="AutoWRX python runtime wrapper")
    parser.add_argument("--script", required=True, help="Python script path")
    parser.add_argument("--vars-out", required=True, help="JSONL output path for vars snapshots")
    parser.add_argument("--control-in", default="", help="JSONL input path for runtime control commands")
    args = parser.parse_args()

    script_path = os.path.abspath(args.script)
    if not os.path.exists(script_path):
        raise FileNotFoundError(f"Script not found: {script_path}")

    script_dir = os.path.dirname(script_path)
    if script_dir and script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    emitter = VarsEmitter(
        script_path=script_path,
        vars_out_path=os.path.abspath(args.vars_out),
        control_in_path=args.control_in,
    )
    old_argv = sys.argv[:]
    try:
        sys.argv = [script_path]
        sys.settrace(emitter.tracer)
        runpy.run_path(script_path, run_name="__main__")
    finally:
        sys.settrace(None)
        sys.argv = old_argv
        emitter.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
