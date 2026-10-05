Imports NUnit.Framework

Namespace Example
    Public Class CounterTests
        <TestCase(-1)>
        <TestCase(2)>
        Public Sub Scale(value As Integer)
            Assert.That(Counter.NextValue(value), [Is].EqualTo(value + 1))
        End Sub
    End Class
End Namespace
