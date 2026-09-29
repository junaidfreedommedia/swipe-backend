const Schema = Mongoose.Schema;
const Status = {
  completed: 'Completed',
  blank: 'Blank',
  dismiss: 'Dismiss'
};

const TestSchema = Schema(
  {
    merchant: {
      type: Schema.Types.ObjectId,
      ref: "merchants",
    },
    install_task: {
      action: String,
      actionLabel: String,
      id: String,
      done: Boolean,
      label: String,
      url: String,
    },
    onboard_task: {
        action: String,
        actionLabel: String,
        id: String,
        done: Boolean,
        label: String,
        url: String,
    },
    partner_task: {
        action: String,
        actionLabel: String,
        id: String,
        done: Boolean,
        label: String,
        popupText: String
    },
    billing_task: {
        action: String,
        actionLabel: String,
        id: String,
        done: Boolean,
        label: String,
    },
    widget_task: {
        action: String,
        actionLabel: String,
        id: String,
        done: Boolean,
        label: String,
        popupText: String
    },
    protect_and_resolve: {
      implement_swipe_protect_widget: {
        type: String,
        enum: [Status.completed, Status.blank, Status.dismiss],
        default: Status.blank 
      },
      setup_shipping_protection_banner: {
        type: String,
        enum: [Status.completed, Status.blank, Status.dismiss],
        default: Status.blank 
      },
      done: {
        type: Boolean,
        default: false
      }
    },
    track: {
      thank_you_page_tracking_link: {
        type: String,
        enum: [Status.completed, Status.blank, Status.dismiss],
        default: Status.blank 
      },
      shopify_tracking_link: {
        type: String,
        enum: [Status.completed, Status.blank, Status.dismiss],
        default: Status.blank 
      },
      order_confirmation_email: {
        type: String,
        enum: [Status.completed, Status.blank, Status.dismiss],
        default: Status.blank 
      },
      done: {
        type: Boolean,
        default: false
      }
    },
    engage: {
      customer_contact_info: {
        type: String,
        enum: [Status.completed, Status.blank, Status.dismiss],
        default: Status.blank  
      },
      done: {
        type: Boolean,
        default: false
      }
    },
    branding_and_profile: {
      branding_and_merchant_profile: {
        type: String,
        enum: [Status.completed, Status.blank, Status.dismiss],
        default: Status.blank 
      },
      setup_merchant_categories: {
        type: String,
        enum: [Status.completed, Status.blank, Status.dismiss],
        default: Status.blank 
      },
      done: {
        type: Boolean,
        default: false
      }
    },
    admin: {
      merchant_communication_email: {
        type: String,
        enum: [Status.completed, Status.blank, Status.dismiss],
        default: Status.blank 
      },
      add_your_team: {
        type: String,
        enum: [Status.completed, Status.blank, Status.dismiss],
        default: Status.blank 
      },
      done: {
        type: Boolean,
        default: false
      }
    },
    finance: {
      approve_shopify_billing: {
        type: String,
        enum: [Status.completed, Status.blank, Status.dismiss],
        default: Status.blank  
      },
      done: {
        type: Boolean,
        default: false
      }
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
module.exports = Mongoose.model("tasks", TestSchema);