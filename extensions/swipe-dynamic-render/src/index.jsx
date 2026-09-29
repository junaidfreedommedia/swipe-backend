import React, {
  useEffect,
  useState,
  useMemo,
  useCallback,
} from "react";
import variantLogic from "./../../../variantLogic";
import {
  InlineStack,
  SkeletonText,
  useCartLines,
  useApplyCartLinesChange,
  useApi,
  Checkbox,
  reactExtension,
  useDeliveryGroups,
  useAttributes,
} from "@shopify/ui-extensions-react/checkout";
import InfoModal from "./../../../InfoModal";

const getProductsQuery = {
  query: `
    query ($first: Int, $title: String!) {
      shop {
        name
      }
      products(first: $first, query: $title) {
        nodes {
          id
          title
          images(first: 1) {
            nodes { url }
          }
          variants(first: 100) {
            nodes {
              id
              title
              price { amount }
            }
          }
        }
      }
    }
  `,
  variables: { first: 5, title: "title:'Swipe'" },
};
const SWIPE_MAX_CART_SUBTOTAL = 2000;

export default reactExtension(
  "purchase.checkout.block.render",
  () => <App />
);

function App() {
  const [products, setProducts] = useState([]);
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [isCartUpdating, setIsCartUpdating] = useState(false);
  const [shouldRenderComponent, setShouldRenderComponent] = useState(true);

  const cartLines = useCartLines();
  const applyCartLinesChange = useApplyCartLinesChange();
  const { query } = useApi();
  const deliveryGroups = useDeliveryGroups();
  const attributes = useAttributes();

  /* -------------------------------------------------
     Shopify delivery detection
  -------------------------------------------------- */
  const { deliveryOptions, selectedDeliveryOption } =
    deliveryGroups[0] ?? {};

  const currentDeliveryOption = deliveryOptions?.find(
    (opt) => opt.handle === selectedDeliveryOption?.handle
  );

  const deliveryType = currentDeliveryOption?.type; // pickup | shipping | local
  const isPickupSelected = deliveryType === "pickup";
  const isLocalDeliverySelected = deliveryType === "local";

  /* -------------------------------------------------
     Zapiet attributes handling
  -------------------------------------------------- */
  const attrMap = useMemo(() => {
    const map = {};
    for (const a of attributes) map[a.key] = a.value;
    return map;
  }, [attributes]);

  const checkoutMethod =
    (attrMap["Checkout-Method"] || "").toLowerCase();

  const pickupDate = attrMap["Pickup-Date"];
  const pickupTime = attrMap["Pickup-Time"];
  const deliveryDate = attrMap["Delivery-Date"];
  const deliveryTime = attrMap["Delivery-Time"];

  const isZapietPickup = checkoutMethod === "pickup";
  const isZapietDelivery = checkoutMethod === "delivery";

  const zapietPickupComplete =
    isZapietPickup &&
    Boolean(pickupDate) &&
    (pickupTime === undefined || pickupTime !== "");

  const zapietDeliveryComplete =
    isZapietDelivery &&
    Boolean(deliveryDate) &&
    (deliveryTime === undefined || deliveryTime !== "");

  /* -------------------------------------------------
     Fetch Swipe product
  -------------------------------------------------- */
  useEffect(() => {
    const fetchProducts = async () => {
      setIsLoadingProducts(true);
      try {
        const { data } = await query(
          getProductsQuery.query,
          { variables: getProductsQuery.variables }
        );

        if (data?.products?.nodes?.length) {
          setProducts(data.products.nodes);
        } else {
          setShouldRenderComponent(false);
        }
      } catch (error) {
        console.error("Error fetching Swipe products:", error);
        setShouldRenderComponent(false);
      } finally {
        setIsLoadingProducts(false);
      }
    };

    fetchProducts();
  }, [query]);

  const swipeProduct = products[0] ?? null;

  const currentSwipeLine = cartLines.find(
    (line) =>
      swipeProduct &&
      line.merchandise.product.id === swipeProduct.id
  );

  const isSwipeInCart = Boolean(currentSwipeLine);

  /* -------------------------------------------------
     Subtotal excluding Swipe
  -------------------------------------------------- */
  const subtotalExcludingSwipe = cartLines.reduce(
    (total, line) => {
      if (
        swipeProduct &&
        line.merchandise.product.id !== swipeProduct.id
      ) {
        return (
          total + Number(line.cost.totalAmount.amount)
        );
      }
      return total;
    },
    0
  );
  const isAboveMaxProtectionSubtotal =
    subtotalExcludingSwipe > SWIPE_MAX_CART_SUBTOTAL;

  /* -------------------------------------------------
     Variant selection
  -------------------------------------------------- */
  const selectedVariantRule =
    variantLogic.find(
      (rule) =>
        rule.min <= subtotalExcludingSwipe &&
        (
          rule.max > subtotalExcludingSwipe ||
          (
            rule.max === SWIPE_MAX_CART_SUBTOTAL &&
            subtotalExcludingSwipe === SWIPE_MAX_CART_SUBTOTAL
          )
        )
    ) || null;

  const targetVariant = swipeProduct?.variants.nodes.find(
    (variant) =>
      variant.title === selectedVariantRule?.title
  );

  /* -------------------------------------------------
     Cart reconciliation (stable)
  -------------------------------------------------- */
  const reconcileCart = useCallback(
    async (actionType) => {
      if (!swipeProduct || !targetVariant) return;
      if (isCartUpdating) return;

      const isAdd = actionType === "add";
      const idToUse = isAdd
        ? targetVariant.id
        : currentSwipeLine?.id;

      if (!idToUse) return;

      setIsCartUpdating(true);
      try {
        const payload = isAdd
          ? {
              type: "addCartLine",
              merchandiseId: idToUse,
              quantity: 1,
            }
          : {
              type: "removeCartLine",
              id: idToUse,
              quantity:
                currentSwipeLine?.quantity ?? 1,
            };

        const result =
          await applyCartLinesChange(payload);

        if (result.type === "error") {
          console.error(
            "Cart update failed:",
            result.message
          );
        }
      } catch (error) {
        console.error(
          "Error updating cart:",
          error
        );
      } finally {
        setIsCartUpdating(false);
      }
    },
    [
      swipeProduct?.id,
      targetVariant?.id,
      currentSwipeLine?.id,
      currentSwipeLine?.quantity,
      applyCartLinesChange,
      isCartUpdating,
    ]
  );

  /* -------------------------------------------------
     EFFECT: Zapiet – remove Swipe ONLY after
     date/time selection is complete
  -------------------------------------------------- */
useEffect(() => {
  if (!isSwipeInCart) return;
  if (isCartUpdating) return;
  if (!isAboveMaxProtectionSubtotal) return;

  reconcileCart("remove");
}, [
  isSwipeInCart,
  isCartUpdating,
  isAboveMaxProtectionSubtotal,
  reconcileCart,
]);

useEffect(() => {
  if (!isSwipeInCart) return;
  if (isCartUpdating) return;

  // Zapiet Pickup → remove immediately
  if (isZapietPickup) {
    reconcileCart("remove");
    return;
  }

  // Zapiet Delivery → wait for date/time
  if (isZapietDelivery && zapietDeliveryComplete) {
    const t = setTimeout(() => {
      reconcileCart("remove");
    }, 300);

    return () => clearTimeout(t);
  }
}, [
  isSwipeInCart,
  isCartUpdating,
  isZapietPickup,
  isZapietDelivery,
  zapietDeliveryComplete,
  reconcileCart,
]);


  /* -------------------------------------------------
     EFFECT: Non-Zapiet pickup / local delivery
  -------------------------------------------------- */
  useEffect(() => {
    if (!isSwipeInCart) return;
    if (isCartUpdating) return;

    // Zapiet is controlling → handled above
    if (isZapietPickup || isZapietDelivery) return;

    if (isPickupSelected || isLocalDeliverySelected) {
      reconcileCart("remove");
    }
  }, [
    isSwipeInCart,
    isCartUpdating,
    isPickupSelected,
    isLocalDeliverySelected,
    isZapietPickup,
    isZapietDelivery,
    reconcileCart,
  ]);

  /* -------------------------------------------------
     Early returns
  -------------------------------------------------- */
  if (isLoadingProducts && products.length === 0) {
    return <SkeletonText inlineSize="large" />;
  }

  if (
    !shouldRenderComponent ||
    !swipeProduct ||
    !targetVariant ||
    isAboveMaxProtectionSubtotal
  ) {
    return null;
  }

  if (isPickupSelected || isLocalDeliverySelected) {
    return null;
  }

  /* -------------------------------------------------
     UI
  -------------------------------------------------- */
  return (
    <InlineStack>
      <Checkbox
        label={`Swipe Package Protection ($${Number(
          targetVariant.price.amount
        ).toFixed(2)})`}
        checked={isSwipeInCart}
        disabled={
          isCartUpdating || isLoadingProducts
        }
        onChange={() => {
          if (isSwipeInCart) {
            reconcileCart("remove");
          } else {
            reconcileCart("add");
          }
        }}
      >
        Swipe Package Protection ($
        {Number(
          targetVariant.price.amount
        ).toFixed(2)}
        )
      </Checkbox>
      <InfoModal />
    </InlineStack>
  );
}
