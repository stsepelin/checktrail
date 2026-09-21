namespace Example.Catalog;

public readonly record struct Quantity(int Value)
{
    public Quantity Add(Quantity other) => new(Value + other.Value);
}
