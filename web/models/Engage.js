const Schema = Mongoose.Schema;

const EngageSchema = Schema(
  {
    merchant: {
      type: Schema.Types.ObjectId,
      ref: "merchants",
    },
    store_name: String,
    website: String,
    bio: String,
    causes: [String],
    logo: String,
    cover_image: String,
    company_contact_email: String,
    company_contact_phone: Number,
    company_contact_link: String,
    support_contact_email: String,
    support_contact_phone: Number,
    support_contact_link: String,
    returns_contact_email: String,
    returns_contact_phone: Number,
    returns_contact_link: String,
    merchant_categories: [String],
    merchant_categories_age: [String],
    merchant_categories_gender: [String],
    feed_image: String
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

module.exports = Mongoose.model("engages", EngageSchema);
