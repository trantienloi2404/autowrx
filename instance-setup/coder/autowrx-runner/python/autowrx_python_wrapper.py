#!/usr/bin/env python3

import argparse
import json
import os
import runpy
import sys
import threading
from queue import Empty, SimpleQueue
from types import FrameType
from typing import Any, Dict


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
    def __init__(self, script_path: str, vars_out_path: str = "", vars_pipe_path: str = "", control_pipe_path: str = ""):
        self.script_path = os.path.abspath(script_path)
        self.vars_out_path = os.path.abspath(vars_out_path) if vars_out_path else ""
        self.vars_pipe_path = os.path.abspath(vars_pipe_path) if vars_pipe_path else ""
        self.control_pipe_path = os.path.abspath(control_pipe_path) if control_pipe_path else ""
        self.last_payload = None
        self.control_queue: SimpleQueue[Dict[str, Any]] = SimpleQueue()
        self.control_thread = None
        self.stream = None
        if self.vars_pipe_path:
            self.stream = open(self.vars_pipe_path, "w", encoding="utf-8", buffering=1)
        elif self.vars_out_path:
            os.makedirs(os.path.dirname(self.vars_out_path), exist_ok=True)
            self.stream = open(self.vars_out_path, "a", encoding="utf-8", buffering=1)
        if self.control_pipe_path:
            self.start_control_reader()

    def close(self) -> None:
        try:
            if self.stream:
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
        if self.stream:
            self.stream.write(json.dumps(payload, ensure_ascii=True) + "\n")

    def start_control_reader(self) -> None:
        if not self.control_pipe_path:
            return
        self.control_thread = threading.Thread(target=self.control_reader_loop, daemon=True)
        self.control_thread.start()

    def control_reader_loop(self) -> None:
        while True:
            try:
                with open(self.control_pipe_path, "r", encoding="utf-8") as control_stream:
                    for line in control_stream:
                        text = str(line or "").strip()
                        if not text:
                            continue
                        try:
                            payload = json.loads(text)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(payload, dict):
                            self.control_queue.put(payload)
            except Exception:
                continue

    def apply_control_commands(self, frame: FrameType) -> None:
        while True:
            try:
                cmd = self.control_queue.get_nowait()
            except Empty:
                break
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
    parser.add_argument("--vars-out", default="", help="JSONL output path for vars snapshots")
    parser.add_argument("--vars-pipe", default="", help="FIFO pipe path for vars snapshots")
    parser.add_argument("--control-pipe", default="", help="FIFO pipe path for runtime control commands")
    args = parser.parse_args()

    script_path = os.path.abspath(args.script)
    if not os.path.exists(script_path):
        raise FileNotFoundError(f"Script not found: {script_path}")

    script_dir = os.path.dirname(script_path)
    if script_dir and script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    emitter = VarsEmitter(
        script_path=script_path,
        vars_out_path=args.vars_out,
        vars_pipe_path=args.vars_pipe,
        control_pipe_path=args.control_pipe,
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
