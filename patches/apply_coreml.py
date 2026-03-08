"""Apply CoreML GPU acceleration patch to babeldoc's doclayout.py.

Rewrites the OnnxModel class to:
1. Detect CoreMLExecutionProvider on macOS and use it with static input shapes
2. Add _make_static_model() for ONNX shape inference with fixed [1,3,1024,1024]
3. Pad images to full target size (not stride-aligned) for static-shape CoreML

Idempotent: skips if already patched.
"""

import os
import sys

site_packages = os.path.join(sys.prefix, "lib")
target = None
for root, dirs, files in os.walk(site_packages):
    if "doclayout.py" in files and "docvision" in root:
        target = os.path.join(root, "doclayout.py")
        break

if not target:
    print("SKIP: doclayout.py not found")
    sys.exit(0)

with open(target, "r") as f:
    src = f.read()

if "CoreMLExecutionProvider" in src:
    print("SKIP: CoreML patch already present")
    sys.exit(0)

# --- Patch 1: Add _FIXED_IMGSZ class variable ---
# Handle both formats: with or without blank line after class declaration
if "class OnnxModel(DocLayoutModel):\n\n    def __init__" in src:
    src = src.replace(
        "class OnnxModel(DocLayoutModel):\n\n    def __init__",
        "class OnnxModel(DocLayoutModel):\n"
        "    _FIXED_IMGSZ = 1024  # fixed input size for static-shape CoreML\n\n"
        "    def __init__",
    )
else:
    src = src.replace(
        "class OnnxModel(DocLayoutModel):\n    def __init__",
        "class OnnxModel(DocLayoutModel):\n"
        "    _FIXED_IMGSZ = 1024  # fixed input size for static-shape CoreML\n\n"
        "    def __init__",
    )

# --- Patch 2: Replace CPU-only provider selection with CoreML-aware logic ---
OLD_PROVIDERS = """\
        for provider in available_providers:
            # disable dml|cuda|
            # directml/cuda may encounter problems under special circumstances
            if re.match(r"cpu", provider, re.IGNORECASE):
                logger.info(f"Available Provider: {provider}")
                providers.append(provider)"""

NEW_PROVIDERS = """\
        use_coreml = os_name == "Darwin" and any(
            re.match(r"coreml", p, re.IGNORECASE) for p in available_providers
        )
        if use_coreml:
            # Fix input shapes to [1, 3, 1024, 1024] so CoreML can take over
            # 96%+ of the graph nodes (658/681) instead of just 3/823.
            model = self._make_static_model(model, self._FIXED_IMGSZ)
            providers = [
                'CoreMLExecutionProvider',
                'CPUExecutionProvider',
            ]
            logger.info(
                "Using CoreMLExecutionProvider with static input "
                f"[1, 3, {self._FIXED_IMGSZ}, {self._FIXED_IMGSZ}]"
            )
        else:
            for provider in available_providers:
                if re.match(r"cpu", provider, re.IGNORECASE):
                    logger.info(f"Available Provider: {provider}")
                    providers.append(provider)"""

src = src.replace(OLD_PROVIDERS, NEW_PROVIDERS)

# --- Patch 3: Insert _make_static_model before from_pretrained ---
MAKE_STATIC = """\
    @staticmethod
    def _make_static_model(model, imgsz):
        \"\"\"Rewrite dynamic input dims to fixed [1, 3, imgsz, imgsz] and run
        shape inference so all intermediate shapes become static.\"\"\"
        from onnx import shape_inference

        for inp in model.graph.input:
            if inp.name == "images":
                dim = inp.type.tensor_type.shape.dim
                for i, val in enumerate([1, 3, imgsz, imgsz]):
                    dim[i].ClearField("dim_param")
                    dim[i].dim_value = val
        try:
            model = shape_inference.infer_shapes(model)
        except Exception:
            pass  # best-effort; CoreML still benefits from fixed input
        return model

    @staticmethod
    def from_pretrained"""

src = src.replace(
    "    @staticmethod\n    def from_pretrained",
    MAKE_STATIC,
)

# --- Patch 4: Full-size padding instead of stride-aligned ---
src = src.replace(
    "        # Calculate padding size and align to stride multiple\n"
    "        pad_w = (new_w - resized_w) % self.stride\n"
    "        pad_h = (new_h - resized_h) % self.stride",
    "        # Pad to full target size (enables static-shape CoreML acceleration)\n"
    "        pad_w = new_w - resized_w\n"
    "        pad_h = new_h - resized_h",
)

with open(target, "w") as f:
    f.write(src)

print("OK: CoreML GPU acceleration patch applied")
