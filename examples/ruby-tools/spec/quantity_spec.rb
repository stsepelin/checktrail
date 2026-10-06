# frozen_string_literal: true

require_relative "../lib/quantity"

RSpec.describe OriginalQuantity do
  [-1, 2].each do |value|
    it("advances original boundary #{value}") do
      raise "Original quantity boundary did not advance" unless described_class.next_quantity(value) == value + 1
    end
  end
end
