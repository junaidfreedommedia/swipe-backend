const Schema = Mongoose.Schema;
const BrandingSchema = Schema(
    {
        merchant: {
            type: Schema.Types.ObjectId,
            ref: "merchants",
        },
        merchant_shopify_id: {
            type: Number,
            default: null
        },
        type: {
            type: String,
            enum: ["swipe", "returnExchange"],
            required: true,
        },
        sub_type: {
            type: String,
            enum: ["claim", "order"],
            required: true,
        },
        logo: String,
        type_face: String,
        bg_image: String,
        banner_text: String,
        banner_background_image: String,
        colors: {
            font_color: String,
            bg_color: String,
            button_bg_color: String,
            button_text_color: String,
            banner_text_color: String,
        },
        show_logo: {
  type: Boolean,
  default: false
},
        button_style: String,
        cart_customization: {
  checkout_button_bg_color: String,
  checkout_button_text_color: String,
  cart_text_color: String
},
cart_customization_enabled: {
  type: Boolean,
  default: false
},
swipe_order_email_enabled: {
    type: Boolean,
    default: false
},
swipe_price_tiers_enabled: {
  type: Boolean,
  default: false
},
swipe_tiers: [
  {
    title: {
      type: String,
      required: true
    },
    min: {
      type: Number,
      required: true
    },
    max: {
      type: Number,
      required: true
    }
  }
],

    },
    {
        timestamps: true,
        id: false,
        toObject: {
            virtuals: true,
            getters: true,
        },
        toJSON: {
            virtuals: true,
            getters: true,
        },
    }
);
// Branding.js (Model File)

BrandingSchema.pre('findOneAndUpdate', async function (next) {
    try {
        const update = this.getUpdate();
        const query = this.getQuery();

        // Agar $set ke andar merchant ObjectId maujood hai ya query mein hai
        const merchantObjectId = update.$set?.merchant || query.merchant;

        if (merchantObjectId) {
            // 1. Merchant model se numerical 'id' dhoondna
            const Merchant = Mongoose.model('merchants');
            const merchantData = await Merchant.findById(merchantObjectId).select('id');

            if (merchantData && merchantData.id) {
                // 2. 'merchant_shopify_id' ko update query mein lazmi add kar dena
                if (!update.$set) update.$set = {};
                update.$set.merchant_shopify_id = merchantData.id;
            }
        }
        next();
    } catch (error) {
        console.error("Auto-sync error:", error);
        next(error);
    }
});
module.exports = Mongoose.model("branding", BrandingSchema);
