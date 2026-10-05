using NUnit.Framework;

namespace Example;

public class CounterTests
{
    [TestCase(-1)]
    [TestCase(2)]
    public void Scale(int value) => Assert.That(Counter.Next(value), Is.EqualTo(value + 1));
}
