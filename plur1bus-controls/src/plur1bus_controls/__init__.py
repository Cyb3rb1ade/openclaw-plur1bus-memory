"""Installable PLUR1BUS controls plugin for Hermes."""

from .plugin import Plur1busControlsPlugin, register
from .service import PLUR1BUS_CONTROLS_CONTAINER

__version__ = "7.4.8"

__all__ = ["PLUR1BUS_CONTROLS_CONTAINER", "Plur1busControlsPlugin", "register", "__version__"]
