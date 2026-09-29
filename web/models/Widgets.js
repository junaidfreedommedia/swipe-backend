const Schema = Mongoose.Schema;

const WidgetSchema = Schema(
  {
    merchant: {
      type: Schema.Types.ObjectId,
      ref: "merchants",
    },
    configure_bar: {
      is_active: Boolean,
      title: String,
      offer_text: String,
      offer_image: String,
      spending_target: String,
      spending_currency: String,
      location: String,
      stickiness: [String],
      close_button: Boolean,
      banner_background_color: String,
      font_family: String,
      font_size: String,
      font_color: String,
    },
    cart_page: {
      is_active: Boolean,
      enable_default_protection: Boolean,
      show_protection_amount: Boolean,
      title: String,
      description: String,
      first_tab_title: String,
      first_tab_description: String,
      second_tab_title: String,
      second_tab_description: String,
      third_tab_title: String,
      third_tab_description: String,
      background_color: String,
      title_text_color: String,
      description_text_color: String,
      popup_title_color: String,
      popup_description_color: String,
    },
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

module.exports = Mongoose.model("widgets", WidgetSchema);
