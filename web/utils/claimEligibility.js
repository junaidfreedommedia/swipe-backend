const { NOT_SWIPE_PROTECTED } = require("../locals/en/messages");

const isSwipeProtectedOrder = (order) => order?.is_protected === true;

const assertSwipeProtectedOrder = (order) => {
    if (isSwipeProtectedOrder(order)) return order;

    const error = new Error(NOT_SWIPE_PROTECTED);
    error.status = 400;
    throw error;
};

module.exports = {
    assertSwipeProtectedOrder,
    isSwipeProtectedOrder,
};
