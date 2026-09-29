const Schema = Mongoose.Schema;

const ShippingNotification = Schema(
  {
    merchant: {
      type: Schema.Types.ObjectId,
      ref: "merchants",
    },
    order_created_email: Boolean,
    order_created_sms: Boolean,
    order_created_notifications: Boolean,
    shipping_email: Boolean,
    shipping_sms: Boolean,
    shipping_notifications: Boolean,
    shipment_delay_email: Boolean,
    shipment_delay_sms: Boolean,
    shipment_delay_notifications: Boolean,
    in_transit_email: Boolean,
    in_transit_sms: Boolean,
    in_transit_notifications: Boolean,
    carrier_delay_email: Boolean,
    carrier_delay_sms: Boolean,
    out_for_delivery_email: Boolean,
    out_for_delivery_sms: Boolean,
    out_for_delivery_notifications: Boolean,
    delivered_email: Boolean,
    delivered_sms: Boolean,
    delivered_notifications: Boolean,
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

module.exports = Mongoose.model("ShippingNotifications", ShippingNotification);
