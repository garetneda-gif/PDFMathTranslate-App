"""Wrapper script that calls pdf2zh-next's stream API directly.

Outputs progress events as JSON lines to stdout, enabling reliable
progress tracking from the Electron main process.

Usage:
    python translate_wrapper.py <pdf2zh-args...>

stdout: one JSON object per line (progress events)
stderr: rich logging (same as pdf2zh CLI)
"""

import asyncio
import json
import logging
import sys


def setup_logging():
    """Mirror pdf2zh-next's logging setup, with graceful fallback."""
    try:
        from rich.logging import RichHandler
        handlers = [RichHandler()]
    except ImportError:
        handlers = [logging.StreamHandler(sys.stderr)]
    logging.basicConfig(level=logging.INFO, handlers=handlers)
    for name in ("httpx", "openai", "httpcore", "http11"):
        lg = logging.getLogger(name)
        lg.setLevel("CRITICAL")
        lg.propagate = False
    for v in logging.Logger.manager.loggerDict.values():
        n = getattr(v, "name", None)
        if n is None:
            continue
        if any(
            k in n
            for k in ("pdfminer", "peewee", "httpx", "http11", "openai")
        ):
            v.disabled = True
            v.propagate = False


def emit(event: dict):
    """Write a JSON event line to stdout and flush immediately."""
    # translate_result is a Python object, convert to dict for JSON
    out = {}
    for k, v in event.items():
        if hasattr(v, "__dict__"):
            out[k] = {
                attr: str(getattr(v, attr))
                for attr in dir(v)
                if not attr.startswith("_") and not callable(getattr(v, attr))
            }
        else:
            out[k] = v
    try:
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except (TypeError, ValueError):
        # Fallback: emit type only
        sys.stdout.write(json.dumps({"type": out.get("type", "unknown")}) + "\n")
        sys.stdout.flush()


async def run():
    from pdf2zh_next.config.model import ConfigManager
    from pdf2zh_next.high_level import do_translate_async_stream

    setup_logging()
    logger = logging.getLogger("translate_wrapper")

    settings = ConfigManager().initialize_config()
    if settings.basic.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    if settings.basic.version:
        from pdf2zh_next import __version__
        print(json.dumps({"type": "version", "version": __version__}))
        return 0

    logger.info("Warmup babeldoc assets...")
    import babeldoc.assets.assets
    babeldoc.assets.assets.warmup()

    input_files = list(settings.basic.input_files)
    assert len(input_files) >= 1, "At least one input file is required"
    settings.basic.input_files = set()

    for file in input_files:
        logger.info(f"translate file: {file}")
        try:
            async for event in do_translate_async_stream(settings, file):
                emit(event)
                if event.get("type") == "finish":
                    result = event.get("translate_result")
                    if result:
                        logger.info("Translation Result:")
                        logger.info(f"  Original PDF: {result.original_pdf_path}")
                        logger.info(f"  Time Cost: {result.total_seconds:.2f}s")
                        logger.info(f"  Mono PDF: {result.mono_pdf_path or 'None'}")
                        logger.info(f"  Dual PDF: {result.dual_pdf_path or 'None'}")
                    break
        except Exception as e:
            logger.error(f"Translation error: {e}")
            emit({"type": "error", "error": str(e)})
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
