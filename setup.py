"""ShareGuard package setup."""

from setuptools import setup, find_packages

setup(
    name="shareguard",
    version="0.2.0",
    description="Degradation-Invariant and Uncertainty-Aware AI-Generated Image Detection",
    author="",
    python_requires=">=3.10",
    packages=find_packages(),
    install_requires=[
        "torch>=2.0.0",
        "torchvision>=0.15.0",
        "timm>=0.9.0",
        "open_clip_torch>=2.20.0",
        "opencv-python>=4.8.0",
        "pillow>=10.0.0",
        "albumentations>=1.3.0",
        "scikit-learn>=1.3.0",
        "scipy>=1.11.0",
        "pandas>=2.0.0",
        "numpy>=1.24.0",
        "matplotlib>=3.7.0",
        "seaborn>=0.12.0",
        "tqdm>=4.65.0",
        "pyyaml>=6.0",
    ],
    entry_points={
        "console_scripts": [
            "shareguard-train=shareguard.engine.train:main",
            "shareguard-eval=shareguard.engine.evaluate:main",
            "shareguard-infer=shareguard.engine.infer:main",
        ],
    },
)
