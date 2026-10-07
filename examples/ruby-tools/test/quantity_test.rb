# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/quantity"

class OriginalQuantityTest < Minitest::Test
  def test_negative_boundary
    assert_equal 0, OriginalQuantity.next_quantity(-1)
  end

  def test_positive_boundary
    assert_equal 3, OriginalQuantity.next_quantity(2)
  end
end
