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

original_src = src
patch_count = 0

# --- Patch 1: Add _FIXED_IMGSZ class variable ---
# Handle both formats: with or without blank line after class declaration
if "class OnnxModel(DocLayoutModel):\n\n    def __init__" in src:
    src = src.replace(
        "class OnnxModel(DocLayoutModel):\n\n    def __init__",
        "class OnnxModel(DocLayoutModel):\n"
        "    _FIXED_IMGSZ = 1024  # fixed input size for static-shape CoreML\n\n"
        "    def __init__",
    )
elif "class OnnxModel(DocLayoutModel):\n    def __init__" in src:
    src = src.replace(
        "class OnnxModel(DocLayoutModel):\n    def __init__",
        "class OnnxModel(DocLayoutModel):\n"
        "    _FIXED_IMGSZ = 1024  # fixed input size for static-shape CoreML\n\n"
        "    def __init__",
    )
if "_FIXED_IMGSZ" in src:
    patch_count += 1
    print("  Patch 1/4 OK: _FIXED_IMGSZ class variable")
else:
    print("  Patch 1/4 FAIL: could not insert _FIXED_IMGSZ")

# --- Patch 2: Replace CPU-only provider selection with CoreML-aware logic ---
# Try multiple known formats of the provider selection block
PROVIDER_PATTERNS = [
    # Format A: with comment lines about dml/cuda
    """\
        for provider in available_providers:
            # disable dml|cuda|
            # directml/cuda may encounter problems under special circumstances
            if re.match(r"cpu", provider, re.IGNORECASE):
                logger.info(f"Available Provider: {provider}")
                providers.append(provider)""",
    # Format B: without comment lines
    """\
        for provider in available_providers:
            if re.match(r"cpu", provider, re.IGNORECASE):
                logger.info(f"Available Provider: {provider}")
                providers.append(provider)""",
    # Format C: with 'CPU' (capitalized)
    """\
        for provider in available_providers:
            if re.match(r"CPU", provider, re.IGNORECASE):
                logger.info(f"Available Provider: {provider}")
                providers.append(provider)""",
]

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

provider_patched = False
for pattern in PROVIDER_PATTERNS:
    if pattern in src:
        src = src.replace(pattern, NEW_PROVIDERS)
        provider_patched = True
        break

if provider_patched:
    patch_count += 1
    print("  Patch 2/4 OK: CoreML provider selection")
else:
    print("  Patch 2/4 FAIL: provider selection pattern not found")
    # Print what's actually there for debugging
    import re as _re
    m = _re.search(r"(for provider in available_providers.*?providers\.append\(provider\))",
                   src, _re.DOTALL)
    if m:
        print(f"  Found block:\n{m.group(0)[:200]}")

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

if "    @staticmethod\n    def from_pretrained" in src and "_make_static_model" not in src:
    src = src.replace(
        "    @staticmethod\n    def from_pretrained",
        MAKE_STATIC,
    )

if "_make_static_model" in src:
    patch_count += 1
    print("  Patch 3/4 OK: _make_static_model method")
else:
    print("  Patch 3/4 FAIL: could not insert _make_static_model")

# --- Patch 4: Full-size padding instead of stride-aligned ---
# Try multiple known formats
PADDING_PATTERNS = [
    (
        "        # Calculate padding size and align to stride multiple\n"
        "        pad_w = (new_w - resized_w) % self.stride\n"
        "        pad_h = (new_h - resized_h) % self.stride"
    ),
    (
        "        pad_w = (new_w - resized_w) % self.stride\n"
        "        pad_h = (new_h - resized_h) % self.stride"
    ),
]
NEW_PADDING = (
    "        # Pad to full target size (enables static-shape CoreML acceleration)\n"
    "        pad_w = new_w - resized_w\n"
    "        pad_h = new_h - resized_h"
)

padding_patched = False
for pattern in PADDING_PATTERNS:
    if pattern in src:
        src = src.replace(pattern, NEW_PADDING)
        padding_patched = True
        break

if padding_patched:
    patch_count += 1
    print("  Patch 4/4 OK: full-size padding")
elif "pad_w = new_w - resized_w" in src:
    patch_count += 1
    print("  Patch 4/4 OK: full-size padding (already present)")
else:
    print("  Patch 4/4 FAIL: padding pattern not found")

# --- Write patched file ---
if src != original_src:
    with open(target, "w") as f:
        f.write(src)

# --- Clear .pyc cache so Python picks up the patched source ---
pycache_dir = os.path.join(os.path.dirname(target), "__pycache__")
if os.path.isdir(pycache_dir):
    cleared = 0
    for fname in os.listdir(pycache_dir):
        if fname.startswith("doclayout.") and fname.endswith((".pyc", ".pyo")):
            try:
                os.remove(os.path.join(pycache_dir, fname))
                cleared += 1
            except OSError:
                pass
    if cleared:
        print(f"  Cleared {cleared} .pyc cache file(s)")

if patch_count == 4:
    print(f"OK: All 4 patches applied to {target}")
elif patch_count > 0:
    print(f"PARTIAL: {patch_count}/4 patches applied to {target}")
    sys.exit(1)
else:
    print(f"FAIL: No patches could be applied to {target}")
    sys.exit(1)
