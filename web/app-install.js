const { GraphqlQueryError } = require("@shopify/shopify-api");
const shopify = require("./shopify.js");
const productObject = require("./product.js");
const jwt = require("jsonwebtoken");
const Config = require("./config/config");
const { taskObject, cartWidget } = require("./commentObject.js");
const Merchant = require("./services/Merchant");
const User = require("./services/User");
const Event = require("./services/Event");
const Services = {
  Branding: require("./services/Branding"),
  Task: require("./services/Task"),
  Widget: require("./services/Widget"),
  Region: require("./services/Region"),
  Merchant: require("./services/Merchant"),
  User: require("./services/User"),
  Webhook: require("./services/Webhook"),
};

const getToken = async (info) =>
  jwt.sign(info, Config.get("APP").SECRET, { expiresIn: "4h" });

async function createSavedProduct(session) {
  if (!shopify.api?.clients?.Graphql) {
    throw new Error("shopify.api.clients.Graphql is undefined – check your setup");
  }
  productObject.handle = `swipe-${session.shop.replace(".myshopify.com", "")}`;

  const client = new shopify.api.clients.Graphql({ session });

  // 🛑 FIX: Product existence check ko hamesha ke liye hata diya gaya hai.
  // Jab app uninstall hota hai aur product admin mein nahi dikhti, 
  // toh code ab creation ko skip nahi karega.
  /*
  const exists = await client.query({
      data: {
          query: `
              query productExists($q: String!) {
                  products(first: 1, query: $q) { nodes { id } }
              }
          `,
          variables: { q: `title:'${productObject.title}'` },
      },
  });
  if (exists.body.data.products.nodes.length) {
      console.log("🔄 Product exists; skipping creation.");
      return exists.body.data.products.nodes[0].id;
  }
  */
  // 🛑 FIX END

  const input = {
    title: productObject.title,
    descriptionHtml: productObject.body_html,
    vendor: productObject.vendor,
    handle: productObject.handle,
    tags: productObject.tags?.split(",") || [],
    productOptions: productObject.options?.map((opt, i) => ({
      name: opt.name,
      position: i + 1,
      values: opt.values?.map(v => ({ name: v }))
    })) || [],
    variants: productObject.variants?.map(v => ({
      optionValues: productObject.options?.length
        ? [{ optionName: productObject.options[0].name, name: v.option1 }]
        : [],
      price: parseFloat(v.price),
      sku: v.sku
    })) || []
  };

  const PRODUCT_SET = `
        mutation productSet($product: ProductSetInput!, $synchronous: Boolean!) {
            productSet(input: $product, synchronous: $synchronous) {
                product { id }
                userErrors { field message }
            }
        }
    `;
  const PRODUCT_MEDIA_CREATE = `
        mutation addMedia($media: [CreateMediaInput!]!, $productId: ID!) {
            productCreateMedia(media: $media, productId: $productId) {
                mediaUserErrors { field message }
            }
        }
    `;
  const GET_PUBLICATIONS = `
        query getPublications {
            publications(first: 10) { nodes { id name } }
        }
    `;
  const PUBLISH_PRODUCT = `
        mutation publishProduct($input: ProductPublishInput!) {
            productPublish(input: $input) {
                userErrors { field message }
            }
        }
    `;

  try {
    console.log("🚀 Creating product...");
    const setResp = await client.request(PRODUCT_SET, {
      variables: { product: input, synchronous: true },
    });

    const { product, userErrors } = setResp.data.productSet;


    if (userErrors && userErrors.length) {
      const handleError = userErrors.find(e =>
        e.field && e.field.includes("handle")
      );

      if (handleError) {
        console.warn("⚠️ Handle exists, fetching existing product...");
        const existing = await getSavedProduct(session, productObject.title);
        if (existing) {
          return existing.id; // ✅ recover, do NOT crash
        }
      }

      console.error("🔴 Product creation failed:", JSON.stringify(userErrors, null, 2));
      throw new Error("productSet errors: " + JSON.stringify(userErrors));
    }


    const productId = product.id;
    console.log(`✅ Product created: ${productId}`);

    if (productObject.images?.length) {
      console.log("🖼️ Adding images...");
      const media = productObject.images?.map(img => ({
        mediaContentType: "IMAGE",
        originalSource: img.src,
        alt: img.altText || ""
      }));
      const mediaResp = await client.request(PRODUCT_MEDIA_CREATE, {
        variables: { media, productId },
      });
      const mediaErrors = mediaResp.data.productCreateMedia.mediaUserErrors;

      if (mediaErrors && mediaErrors.length) {
        console.warn("⚠️ Image errors:", mediaErrors);
      } else {
        console.log("🖼️ Images added.");
      }
    }

    console.log("🌐 Fetching channels...");
    const pubsResp = await client.request(GET_PUBLICATIONS);
    const publications = pubsResp.data.publications.nodes;

    const channelsToPublish = ["Online Store", "Point of Sale"];

    for (const channelName of channelsToPublish) {
      const pub = publications.find(p => p.name === channelName);
      if (!pub) {
        console.warn(`⚠️ Channel not found: ${channelName}`);
        continue;
      }
      console.log(`🔄 Publishing to ${channelName}...`);
      const pubResp = await client.request(PUBLISH_PRODUCT, {
        variables: {
          input: {
            id: productId,
            productPublications: [{ publicationId: pub.id }],
          },
        },
      });
      const errs = pubResp.data.productPublish.userErrors;

      if (errs && errs.length) {
        console.error(`❌ Publish errors on ${channelName}:`, errs);
      } else {
        console.log(`🎉 Published on ${channelName}!`);
      }
    }

    return productId;

  } catch (err) {
    if (err instanceof GraphqlQueryError) {
      console.error("🔴 GraphQL error:", err.message, err.response.errors);
    } else {
      console.error("🔴 Unexpected error:", err);
    }
    throw err;
  }
}

const getSavedProduct = async (session) => {
  const client = new shopify.api.clients.Graphql({ session });

  const handle = `swipe-${session.shop.replace(".myshopify.com", "")}`;

  const QUERY = `
    query findSwipeProduct($q1: String!, $q2: String!, $q3: String!) {
      byFullTitle: products(first: 1, query: $q1) {
        nodes { id title handle }
      }
      byPartialTitle: products(first: 1, query: $q2) {
        nodes { id title handle }
      }
      byHandle: products(first: 1, query: $q3) {
        nodes { id title handle }
      }
    }
  `;

  const resp = await client.request(QUERY, {
    variables: {
      q1: `title:"Swipe Package Protection"`,
      q2: `title:Swipe`,
      q3: `handle:${handle}`,
    },
  });

  const fullTitle = resp.data?.byFullTitle?.nodes || [];
  const partialTitle = resp.data?.byPartialTitle?.nodes || [];
  const byHandle = resp.data?.byHandle?.nodes || [];


  if (fullTitle.length) return fullTitle[0];
  if (partialTitle.length) return partialTitle[0];
  if (byHandle.length) return byHandle[0];

  return null;
};


const registerWebhooks = async function (session) {
  try {
    const {
      TOPIC,
      URL: WebhookHttpEndpoint,
      format,
    } = Config.get("WEBHOOK");
    const allWebhooks = await shopify.api.rest.Webhook.all({
      session: session,
    });
    const alreadyExistsWebhooks = {};
    for (let webhook of allWebhooks.data) {
      const existsORrNot = Object.keys(TOPIC).find(
        (key) => TOPIC[key] === webhook.topic
      );
      if (existsORrNot) alreadyExistsWebhooks[existsORrNot] = webhook;
    }
    const prepareWebhooksPayload = ({ info, topicName, id, topic }) => {
      const url = `${WebhookHttpEndpoint}${topicName}`;
      info.address = url;
      if (id) {
        info.id = id;
        return info;
      }
      info.topic = topic;
      info.format = format;
      return info;
    };
    const newWebhookObj = () => new shopify.api.rest.Webhook({ session });

    for (let topicName in TOPIC) {
      const updateWebhook = alreadyExistsWebhooks[topicName];
      let topicOrId = updateWebhook
        ? { id: updateWebhook.id }
        : { topic: TOPIC[topicName] };
      let webhookObj = prepareWebhooksPayload({
        info: newWebhookObj(),
        topicName,
        ...topicOrId,
      });
      await webhookObj.save({ update: true });
    }

    return Promise.resolve({});
  } catch (error) {
    console.log(error);
    // throw error;
  }
};

const saveStoreInformation = async function (session) {
  try {
    let store_logo = "";
    let merchantInfo = await Merchant.get({ shop_id: session.shop });
    if (!merchantInfo || merchantInfo.is_active == false) {
      let shop = await shopify.api.rest.Shop.all({ session });
      shop = shop.data[0].toJSON();
      // const themes = await shopify.api.rest.Theme.all({ session });
      // const [active] = themes.data.filter((thm) => thm.role === "main");
      // if (active) {
      //     const setting_data = await shopify.api.rest.Asset.all({
      //         session: session,
      //         theme_id: active.id,
      //         asset: { key: "config/settings_data.json" },
      //     });
      //     let logo_name = JSON.parse(setting_data.data[0].value)?.current
      //         .logo;
      //     if (logo_name) {
      //         logo_name = logo_name.split("/").pop();
      //         store_logo = `https://${shop.myshopify_domain}/cdn/shop/files/${logo_name}`;
      //     }
      // }
      merchantInfo = await Merchant.findOneAndUpdate(
        { shop_id: session.shop },
        {
          $set: {
            shop_id: session.shop,
            is_active: true,
            store_logo,
            platform: "Shopify",
            ...shop,
          },
        },
        { upsert: true, new: true }
      );

      await Services.Branding.insert({
        merchant: merchantInfo._id,
        type: "swipe",
        sub_type: "order",
        logo: "https://swipe.ai/wp-content/uploads/2024/05/swipe-email-logo.png",
        type_face: "sans-serif",
        bg_image:
          "https://swipe-images-01.s3.amazonaws.com/high-angle-delivery-truck-boxes+1.jpg",
        banner_text: "Order Delivery Update",
        banner_background_image:
          "https://blog.shift4shop.com/hubfs/iStock-871823596.jpg",
        banner_text_color: "#000000",
        colors: {
          font_color: "#000000",
          bg_color: "#FFF382",
          button_bg_color: "#000000",
          button_text_color: "#f3efef",
        },
        button_style: "default",
      });
      // Notifications.sendNotification({
      //     subject: `App Installed`,
      //     to: [merchantInfo.email],
      //     template: "APP_INSTALLED",
      //     merchant_name: merchantInfo.name,
      // });
      Event.insert({
        merchant: merchantInfo._id,
        type: "APP",
        sub_type: "INSTALL",
        ts: Math.floor(new Date().getTime() / 1000),
        action_on: ACTIVITY_LOG_LABEL.MERCHANT,
        title: EVENT_TITLE.APP_INSTALL,
      });
      taskObject.install_task.done = true;
      Services.Task.findOneAndUpdate(
        { merchant: merchantInfo._id },
        { $set: { merchant: merchantInfo._id, ...taskObject } },
        { upsert: true }
      );
      Services.Widget.findOneAndUpdate(
        { merchant: merchantInfo._id },
        { $set: { merchant: merchantInfo._id, ...cartWidget } },
        { upsert: true }
      );
    }
    return merchantInfo;
  } catch (error) {
    console.log(error);
    throw error;
  }
};

module.exports = {
  appStatus: async function (session) {
    try {
      const merchantInfo = await Merchant.get({
        shop_id: session.shop,
        is_active: true,
      });

      if (!merchantInfo) {
        return { installed: false, registered: false };
      }

      const usersInfo = await User.get({
        merchant: merchantInfo._id,
        password: { $exists: true, $ne: null, $ne: "" },
      });

      const registered = !!(usersInfo && usersInfo.email && usersInfo.password);
      const token = await getToken({
        merchantId: merchantInfo._id,
        name: merchantInfo.name,
        email: merchantInfo.customer_email,
      });

      return {
        installed: true,
        registered,
        token,
        ...merchantInfo,
      };

    } catch (error) {
      console.log(error);
      throw error;
    }
  },

  installApp: async function (session) {
    try {
      const merchantInfo = await saveStoreInformation(session);
      if (!merchantInfo) return { registered: false };

      const usersInfo = await User.get({
        merchant: merchantInfo._id,
        password: { $exists: true, $ne: null, $ne: "" },
      });
      const registered = !!(usersInfo && usersInfo.email && usersInfo.password);

      const token = await getToken({
        merchantId: merchantInfo._id,
        name: merchantInfo.name,
        email: merchantInfo.customer_email,
      });

      const existing = await getSavedProduct(session);
      if (!existing) {
        await createSavedProduct(session);
      }

      await Services.Webhook.registerWebhooks(session);

      let region = await Services.Region.getResource({ default: true });
      if (region) {
        await Services.Merchant.updateOne(
          { _id: merchantInfo._id },
          { $set: { account_manager: region.manager.user } }
        );

        const account_manager = await Services.User.get(
          { _id: region.manager.user },
          { display_name: 1, email: 1 }
        );

        if (account_manager && account_manager.display_name) {
          Notifications.sendNotification({
            subject: `Meet Your New Swipe Account Manager!`,
            to: [merchantInfo.email],
            template: "ACCOUNT_MANAGER",
            merchant_name: merchantInfo.name,
            manager_name: account_manager.display_name,
            manager_email: account_manager.email,
          });
        } else {
          console.warn(`[INSTALL WARNING] Account manager user (ID: ${region.manager.user}) not found for notification.`);
        }


        await Services.Region.updateLastAssign({
          type: "manager",
          _id: region._id,
          user: region.manager.user,
        });
      }

      return { token, registered: !!registered, ...merchantInfo };

    } catch (error) {
      console.log("Error on Install");
      console.log(error);
      throw error;
    }
  },

  createSavedProduct
};
