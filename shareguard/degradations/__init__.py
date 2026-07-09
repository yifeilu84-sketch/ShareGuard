from .jpeg import JPEG, WEBP
from .resize import Resize, RandomResize
from .crop import CenterCrop, RandomCrop
from .blur import GaussianBlur, MotionBlur
from .color import Brightness, Contrast, RandomColorJitter
from .overlay import WhiteBorder, TextOverlay
from .compose import DegradationComposer, compose_degradations
from .registry import DegradationRegistry
