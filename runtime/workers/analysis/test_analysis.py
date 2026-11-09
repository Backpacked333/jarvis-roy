"""Deterministic offline acceptance fixtures for the authored analysis image."""
import hashlib
import importlib.metadata
import io
import math
import os

os.environ["MPLCONFIGDIR"] = "/tmp/jarvis-matplotlib"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
import scipy.integrate
import scipy.optimize
import sympy as sp
from PIL import Image


def test_pinned_libraries_import_and_report_exact_versions():
    expected = {"numpy": "2.3.5", "scipy": "1.16.3", "pandas": "2.3.3", "sympy": "1.14.0",
                "matplotlib": "3.10.7", "pytest": "8.4.2"}
    assert {name: importlib.metadata.version(name) for name in expected} == expected


def test_symbolic_and_numerical_results_agree():
    x = sp.Symbol("x", real=True)
    exact = sp.integrate(x ** 2, (x, 0, 1))
    measured, error_bound = scipy.integrate.quad(lambda value: value ** 2, 0, 1)
    assert exact == sp.Rational(1, 3)
    assert abs(measured - float(exact)) <= max(error_bound, 1e-14)
    root = scipy.optimize.brentq(lambda value: value ** 2 - 2, 1, 2)
    assert root == pytest.approx(math.sqrt(2), abs=1e-12)


def test_linear_algebra_and_tabular_results():
    matrix = np.array([[3.0, 1.0], [1.0, 2.0]])
    result = np.linalg.solve(matrix, np.array([9.0, 8.0]))
    np.testing.assert_allclose(result, [2.0, 3.0], rtol=0, atol=1e-12)
    frame = pd.read_csv(io.StringIO("group,value\na,2\nb,4\na,3\n"))
    assert frame.groupby("group")["value"].sum().to_dict() == {"a": 5, "b": 4}


def render_plot():
    figure, axis = plt.subplots(figsize=(4, 3), dpi=100)
    x = np.linspace(0, 1, 11)
    axis.plot(x, x ** 2, label="y = x²")
    axis.set(xlabel="x", ylabel="y", title="Deterministic analysis fixture", xlim=(0, 1), ylim=(0, 1))
    axis.legend()
    target = io.BytesIO()
    figure.savefig(target, format="png", metadata={"Software": "Jarvis analysis fixture v1"})
    plt.close(figure)
    return target.getvalue()


def test_headless_plot_has_real_pixels_and_repeats_exactly():
    first, second = render_plot(), render_plot()
    assert first.startswith(b"\x89PNG\r\n\x1a\n")
    assert hashlib.sha256(first).digest() == hashlib.sha256(second).digest()
    image = Image.open(io.BytesIO(first))
    assert image.size == (400, 300)
    assert np.asarray(image.convert("RGB")).std() > 10
