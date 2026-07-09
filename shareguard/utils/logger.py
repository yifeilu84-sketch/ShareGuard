"""Logging utilities."""

import logging
import sys
from pathlib import Path
from typing import Optional, Union


def setup_logger(
    name: str = "noisyshare",
    log_file: Optional[Union[str, Path]] = None,
    level: int = logging.INFO,
    fmt: str = "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
) -> logging.Logger:
    """Setup logger with console and optional file handler.

    Args:
        name: Logger name.
        log_file: Path to log file. If None, only console handler is added.
        level: Logging level.
        fmt: Log format string.

    Returns:
        Configured logger instance.
    """
    logger = logging.getLogger(name)
    logger.setLevel(level)
    logger.handlers.clear()

    formatter = logging.Formatter(fmt, datefmt="%Y-%m-%d %H:%M:%S")

    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # File handler
    if log_file is not None:
        log_file = Path(log_file)
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

    return logger


def get_logger(name: str = "noisyshare") -> logging.Logger:
    """Get existing logger by name."""
    return logging.getLogger(name)
