#[path = "with space.rs"]
mod arithmetic;

pub fn value() -> usize {
    arithmetic::value()
}
