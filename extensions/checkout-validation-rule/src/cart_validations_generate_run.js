// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

const RESTRICTED_HANDLES = ["swipe"];

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  // deliveryGroups is populated only during checkout, not during cart mutations
  // (add/update/remove). Skip validation for cart mutations so users can
  // freely remove products without hitting 422 errors.
  const isCheckout = input.cart.deliveryGroups.length > 0;
  if (!isCheckout) {
    return { operations: [] };
  }

  const lines = input.cart.lines;

  const isRestricted = (line) => {
    const merchandise = line.merchandise;
    if (!merchandise || merchandise.__typename !== "ProductVariant") return false;
    return RESTRICTED_HANDLES.includes(merchandise.product?.handle?.toLowerCase() ?? "");
  };

  const hasRestricted = lines.some(isRestricted);
  const hasOther = lines.some((line) => !isRestricted(line));

  if (hasRestricted && !hasOther) {
    return {
      operations: [
        {
          validationAdd: {
            errors: [
              {
                message: "You cannot purchase Swipe on its own. Please add other items to your cart.",
                target: "$.cart",
              },
            ],
          },
        },
      ],
    };
  }

  return { operations: [] };
}
