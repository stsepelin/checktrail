#include "range.h"
int main(void) {
  if (original_c_next(-1) != 0)
    return 1;
  if (original_c_next(2) != 3)
    return 1;
  return 0;
}
