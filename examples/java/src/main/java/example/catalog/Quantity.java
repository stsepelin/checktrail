package example.catalog;

public record Quantity(int value) {
    public Quantity add(Quantity other) {
        return new Quantity(value + other.value);
    }
}
