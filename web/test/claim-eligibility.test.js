const test = require("node:test");
const assert = require("node:assert/strict");

const {
    assertSwipeProtectedOrder,
    isSwipeProtectedOrder,
} = require("../utils/claimEligibility");

test("accepts only orders explicitly marked as Swipe protected", () => {
    const protectedOrder = { is_protected: true };

    assert.equal(isSwipeProtectedOrder(protectedOrder), true);
    assert.equal(assertSwipeProtectedOrder(protectedOrder), protectedOrder);
});

test("rejects orders marked as unprotected", () => {
    assert.throws(
        () => assertSwipeProtectedOrder({ is_protected: false }),
        (error) => {
            assert.equal(error.message, "This order is not protected by Swipe.");
            assert.equal(error.status, 400);
            return true;
        }
    );
});

test("rejects orders with a missing or non-boolean protection flag", () => {
    assert.equal(isSwipeProtectedOrder({}), false);
    assert.equal(isSwipeProtectedOrder({ is_protected: "true" }), false);
    assert.throws(() => assertSwipeProtectedOrder({}));
    assert.throws(() => assertSwipeProtectedOrder(null));
});
