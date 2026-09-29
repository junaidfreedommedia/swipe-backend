window.cartItems = {{ cart.items | json }};
window.postMoneyFomat = '{{ shop.money_format }}';

// Clean the currency string for proper JS number parsing (removes commas and symbols)
// This result will be passed to the cartAmount variable inside the function.
const cartAmountLiquidString = "{{ cart.items_subtotal_price | money_without_currency | remove: ',' | remove: ' ' }}";
let cartAmountInCents = parseFloat(cartAmountLiquidString) * 100 || 0;


// 2. DYNAMIC HTML INJECTION (Replaces your <div> block)
const protectionHtmlContainer = `
    <div class="post-protect_cart" data-shop="{{ shop.id }}" style="display:none;">
        <div class="post-protect_container">
            <div class="pp-toggle-wrapper">
                <form class="pp-checkbox">
                    <input type="checkbox" id="post_protection_checkbox" /><label
                        for="post_protection_checkbox">Toggle</label>
                </form>

            </div>
        </div>
    </div>
`;
document.body.insertAdjacentHTML('beforeend', protectionHtmlContainer);
