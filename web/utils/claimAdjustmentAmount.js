const toCents = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
};

const getLineItemGrossUnitCents = (lineItem = {}) =>
  toCents(
    lineItem.price ??
      lineItem.price_set?.shop_money?.amount ??
      lineItem.price_set?.presentment_money?.amount ??
      0
  );

const calculateReorderGrossTotal = (lineItems = [], selectedItems = []) => {
  const lineItemMap = new Map(
    (Array.isArray(lineItems) ? lineItems : []).map((item) => [
      String(item?.id),
      item,
    ])
  );

  const totalCents = (Array.isArray(selectedItems) ? selectedItems : []).reduce(
    (total, selectedItem) => {
      const id = String(
        selectedItem?.id ??
          selectedItem?.item_id ??
          selectedItem?.line_item_id ??
          ""
      );
      const lineItem = lineItemMap.get(id);
      const quantity = Math.max(Number(selectedItem?.quantity || 0), 0);

      if (!lineItem || quantity <= 0) return total;
      return total + getLineItemGrossUnitCents(lineItem) * quantity;
    },
    0
  );

  return totalCents / 100;
};

module.exports = {
  calculateReorderGrossTotal,
};
