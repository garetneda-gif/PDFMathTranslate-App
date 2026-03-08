"""Apply CoreML GPU acceleration patch to babeldoc's doclayout.py.

Rewrites OnnxModel to:
1. Add fixed image size class variable for static-shape CoreML
2. Select CoreMLExecutionProvider with static [1, 3, 1024, 1024] input
3. Add _make_static_model() to rewrite dynamic input shapes
4. Pad to full target size for static-shape inference

Safety:
- Idempotent when already fully patched
- Can repair partially patched files
- Atomic write: only writes when all 4 patch checks pass
"""

import os
import sys


def find_target() -> str | None:
    site_packages = os.path.join(sys.prefix, "lib")
    for root, _dirs, files in os.walk(site_packages):
        if "doclayout.py" in files and "docvision" in root:
            return os.path.join(root, "doclayout.py")
    return None


def clear_pyc_cache(target: str) -> None:
    pycache_dir = os.path.join(os.path.dirname(target), "__pycache__")
    if not os.path.isdir(pycache_dir):
        return
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


target = find_target()
if not target:
    print("SKIP: doclayout.py not found")
    sys.exit(0)

with open(target, "r", encoding="utf-8") as f:
    src = f.read()

original_src = src
patch_count = 0

has_fixed_imgsz = "_FIXED_IMGSZ = 1024" in src
has_provider_patch = (
    'use_coreml = os_name == "Darwin"' in src
    and "CoreMLExecutionProvider" in src
    and "model = self._make_static_model(model, self._FIXED_IMGSZ)" in src
)
has_make_static_model = "def _make_static_model(model, imgsz):" in src
has_full_padding = (
    "pad_w = new_w - resized_w" in src
    and "pad_h = new_h - resized_h" in src
)

if (
    has_fixed_imgsz
    and has_provider_patch
    and has_make_static_model
    and has_full_padding
):
    print("SKIP: CoreML patch already present (4/4)")
    sys.exit(0)

# --- Patch 1: Add _FIXED_IMGSZ class variable ---
if not has_fixed_imgsz:
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
has_fixed_imgsz = "_FIXED_IMGSZ = 1024" in src
if has_fixed_imgsz:
    patch_count += 1
    print("  Patch 1/4 OK: _FIXED_IMGSZ class variable")
else:
    print("  Patch 1/4 FAIL: could not insert _FIXED_IMGSZ")

# --- Patch 2: Replace CPU-only provider selection with CoreML-aware logic ---
PROVIDER_PATTERNS = [
    """\
        for provider in available_providers:
            # disable dml|cuda|
            # directml/cuda may encounter problems under special circumstances
            if re.match(r"cpu", provider, re.IGNORECASE):
                logger.info(f"Available Provider: {provider}")
                providers.append(provider)""",
    """\
        for provider in available_providers:
            if re.match(r"cpu", provider, re.IGNORECASE):
                logger.info(f"Available Provider: {provider}")
                providers.append(provider)""",
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
                "CoreMLExecutionProvider",
                "CPUExecutionProvider",
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

if not has_provider_patch:
    for pattern in PROVIDER_PATTERNS:
        if pattern in src:
            src = src.replace(pattern, NEW_PROVIDERS)
            break
has_provider_patch = (
    'use_coreml = os_name == "Darwin"' in src
    and "CoreMLExecutionProvider" in src
    and "model = self._make_static_model(model, self._FIXED_IMGSZ)" in src
)
if has_provider_patch:
    patch_count += 1
    print("  Patch 2/4 OK: CoreML provider selection")
else:
    print("  Patch 2/4 FAIL: provider selection pattern not found")

# --- Patch 3: Insert _make_static_model before from_pretrained ---
MAKE_STATIC_WITH_DECORATOR = """\
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

MAKE_STATIC_NO_DECORATOR = """\
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

    def from_pretrained"""

if not has_make_static_model:
    if "    @staticmethod\n    def from_pretrained" in src:
        src = src.replace(
            "    @staticmethod\n    def from_pretrained",
            MAKE_STATIC_WITH_DECORATOR,
        )
    elif "    def from_pretrained" in src:
        src = src.replace("    def from_pretrained", MAKE_STATIC_NO_DECORATOR)
has_make_static_model = "def _make_static_model(model, imgsz):" in src
if has_make_static_model:
    patch_count += 1
    print("  Patch 3/4 OK: _make_static_model method")
else:
    print("  Patch 3/4 FAIL: could not insert _make_static_model")

# --- Patch 4: Full-size padding instead of stride-aligned ---
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

if not has_full_padding:
    for pattern in PADDING_PATTERNS:
        if pattern in src:
            src = src.replace(pattern, NEW_PADDING)
            break
has_full_padding = (
    "pad_w = new_w - resized_w" in src
    and "pad_h = new_h - resized_h" in src
)
if has_full_padding:
    patch_count += 1
    print("  Patch 4/4 OK: full-size padding")
else:
    print("  Patch 4/4 FAIL: padding pattern not found")

if patch_count != 4:
    print(f"FAIL: patch validation failed ({patch_count}/4), file left unchanged: {target}")
    sys.exit(1)

# Atomic write: only persist after all checks passed
if src != original_src:
    with open(target, "w", encoding="utf-8") as f:
        f.write(src)
    clear_pyc_cache(target)

print(f"OK: All 4 patches verified for {target}")
