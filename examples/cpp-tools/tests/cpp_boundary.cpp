#include "range.hpp"
int main() {
  if (original_cpp_next(-1) != 0)
    return 1;
  if (original_cpp_next(2) != 3)
    return 1;
  return 0;
}
