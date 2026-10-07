namespace Example

open NUnit.Framework

[<TestFixture>]
type CounterTests() =
    [<TestCase(-1)>]
    [<TestCase(2)>]
    member _.Scale(value: int) = Assert.That(Counter.next value, Is.EqualTo(value + 1))
