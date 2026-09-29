import React, { useEffect, useState } from "react";
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
} from "@shopify/ui-extensions-react/checkout";
import InfoModal from "./../../../InfoModal";

let defaultProtection = false; /* for adding swipe protection as by default */
let defaultProtectionStore = "lola"; /* for adding swipe protection as by default */

// GraphQL query to fetch "Swipe" products
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
}
const SWIPE_MAX_CART_SUBTOTAL = 2000;

// Register the extension at Shopify's checkout block
export default reactExtension("purchase.checkout.block.render", () => <Extension />);

function Extension() {
  /*  State declarations */
  const [shopName, setShopName] = useState("");
  const [products, setProducts] = useState([]);        // Stores "Swipe" product data
  const [isLoading, setIsLoading] = useState(false);  // Tracks loading state
  const [shouldRender, setShouldRender] = useState(true); // Controls visibility
  const [isProtectionAvailable, setIsProtectionAvailable] = useState(true); // True if Swipe isn't in cart
  const [isFirstLoad, setIsFirstLoad] = useState(true); // Tracks first load

  /* Shopify hooks */
  const cartLines = useCartLines();
  const applyCartLinesChange = useApplyCartLinesChange();
  const { query } = useApi();
  const deliveryGroups = useDeliveryGroups();

  // Fetch products on mount
  useEffect(() => {
    const fetchProducts = async () => {
      setIsLoading(true);
      try {
        const { data } = await query(getProductsQuery.query, { variables: getProductsQuery.variables });
        if(data?.shop?.name) {
          setShopName(data.shop.name);
        }
        if (data?.products.nodes.length) {
          setProducts(data.products.nodes);
        } else {
          setShouldRender(false);
        }
      } catch (error) {
        console.error("Error fetching Swipe products:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchProducts();
  }, [query]); // Only run once, depend on query

  // Function to add or remove Swipe protection
  const updateCartWithProtection = async ({ id, type, showLoading = true }) => {
    if (!id) return; // Guard against blank id
    setIsLoading(true);

    try {
      const payload = {
        quantity: 1,
        type: type === "add" ? "addCartLine" : "removeCartLine",
        [type === "add" ? "merchandiseId" : "id"]: id,
      };

      const result = await applyCartLinesChange(payload);
      if (result.type === "error") {
        console.error("Cart update failed:", result.message);
        setIsProtectionAvailable(type === "add"); // Revert on failure
      } else {
        setIsProtectionAvailable(type === "remove"); // Update on success
      }
    } catch (error) {
      console.error("Error updating cart:", error);
      setIsProtectionAvailable(type === "add"); // Revert on exception
    } finally {
      setIsLoading(false);
    }
  };

  // Early returns
  if (isLoading) return <SkeletonText inlineSize="large" />;
  if (!shouldRender || !products.length) return null;

  // Calculate subtotal excluding Swipe
  const subtotalExcludingSwipe = cartLines.reduce((total, line) => {
    return products[0].id !== line.merchandise.product.id
      ? total + Number(line.cost.totalAmount.amount)
      : total;
  }, 0);
  const isAboveMaxProtectionSubtotal =
    subtotalExcludingSwipe > SWIPE_MAX_CART_SUBTOTAL;

  // Select target variant based on subtotal
  const selectedVariantRule = variantLogic.find(
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
  const targetVariant = products[0].variants.nodes.find(
    (variant) => variant.title === selectedVariantRule?.title
  );

  if (isAboveMaxProtectionSubtotal) {
    return null;
  }

  if (!targetVariant) {
    console.warn(`No variant found for title "${selectedVariantRule?.title}"`);
    return null;
  }

  // Check delivery option and handle pickup
  
  const { deliveryOptions, selectedDeliveryOption } = deliveryGroups[0] ?? {};
  const currentDeliveryOption = deliveryOptions?.find(
    ({ handle }) => handle === selectedDeliveryOption?.handle
  );
  const isPickup = currentDeliveryOption?.type === "pickup";

  // if pickup is selected then remove swipe and hide checkbox 
  if (isPickup && isSwipeInCart) {
    updateCartWithProtection({ id: currentSwipeLine.id, type: "remove", showLoading: false });
    return null;
  }

  // Check current Swipe item in cart
  const currentSwipeLine = cartLines.find(
    (line) => line.merchandise.product.id === products[0].id
  );
  const isSwipeInCart = !!currentSwipeLine;
  const hasCorrectVariant = currentSwipeLine?.merchandise.subtitle === targetVariant.title;

  /* update default protection value for Lola store */
  if(shopName && shopName.toLowerCase().includes(defaultProtectionStore)) {
    defaultProtection = true;
  }

  // Sync cart if Swipe exists with wrong variant
  if (isSwipeInCart && !hasCorrectVariant) {
    setIsFirstLoad(false);
    updateCartWithProtection({ id: currentSwipeLine.id, type: "remove", showLoading: false }).then(() => {
      updateCartWithProtection({ id: targetVariant.id, type: "add", showLoading: false });
    });
  } else if (!isPickup && !isSwipeInCart && isFirstLoad && defaultProtection) {
    setIsFirstLoad(false);
    updateCartWithProtection({ id: targetVariant.id, type: "add", showLoading: false });
  }

  // Sync availability state
  if (isSwipeInCart && isProtectionAvailable) setIsProtectionAvailable(false);
  if (!isSwipeInCart && !isProtectionAvailable) setIsProtectionAvailable(true);
  if(isFirstLoad) setIsFirstLoad(false);

  // Render UI
  return (
    <InlineStack>
      <Checkbox
        label={`Add Swipe Protection (${targetVariant.title})`}
        className="checkout-box"
        checked={!isProtectionAvailable}
        onChange={() => {
          if (isProtectionAvailable) {
            updateCartWithProtection({ id: targetVariant.id, type: "add" });
          } else if (currentSwipeLine) {
            updateCartWithProtection({ id: currentSwipeLine.id, type: "remove" });
          }
        }}
        id="checkbox"
        name="checkbox"
      >
		Add Swipe Protection
		</Checkbox>
      <InfoModal />
    </InlineStack>
  );
}
