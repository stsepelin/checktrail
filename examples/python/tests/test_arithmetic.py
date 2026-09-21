import unittest
from arithmetic import add


class ArithmeticTest(unittest.TestCase):
    def test_signed_integers(self):
        self.assertEqual(add(2, 3), 5)
        self.assertEqual(add(-2, 3), 1)
        self.assertEqual(add(0, 0), 0)
