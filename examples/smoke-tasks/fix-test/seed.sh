#!/usr/bin/env bash
set -euo pipefail

cat > math_utils.py <<'EOF'
def add(a, b):
    return a - b
EOF

cat > test_math_utils.py <<'EOF'
import unittest

from math_utils import add


class MathUtilsTest(unittest.TestCase):
    def test_adds_two_numbers(self):
        self.assertEqual(add(2, 3), 5)


if __name__ == "__main__":
    unittest.main()
EOF
