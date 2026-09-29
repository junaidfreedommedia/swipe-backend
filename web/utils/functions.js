require("../validation/validator");
const puppeteer = require("puppeteer");
const fs = require("fs");
const AWS_CREDENTIALS = Config.get("AWS_CREDENTIALS");

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

/**
 * AWS S3 Client (v3)
 * Uses the same credentials/config previously set via AWS.config.update(...)
 */
const s3 = new S3Client({
  region: AWS_CREDENTIALS.AWS_REGION,
});


function claimtable(claims) {
  if (!claims || !Array.isArray(claims)) return "";

  let claimdata = "";
  let template = `<tr>
    <td style="padding: 2px 0;">[CLAIM_DATE]</td>
    <td style="padding: 2px 0;">[RESOLVE_DATE]</td>
    <td style="padding: 2px 0;">[ORDER_NAME]</td>
    <td style="padding: 2px 0;">[TYPE]</td>
    <td style="text-align: left;padding: 2px 0;">[TOTAL_CLAIM]</td>
  </tr>`;

  const processedOrders = new Set();

  claims.forEach((claimdetails) => {
    const orderName = claimdetails.order_name || "Unknown";
    if (processedOrders.has(orderName)) return;
    processedOrders.add(orderName);
    let trueAmount = 0;
    if (claimdetails.combined_refund_total) {
      trueAmount = parseFloat(claimdetails.combined_refund_total);
    } else if (claimdetails.amount) {
      trueAmount = parseFloat(claimdetails.amount);
    } else {
      trueAmount = parseFloat(
        (claimdetails.claim_total || "0")
          .toString()
          .replace(/[^0-9.-]/g, "")
      );
    }

    const finalPrice = trueAmount.toFixed(2);
    const tz = claimdetails.merchant_timezone || "America/Chicago";

    const claimdate = claimdetails.createdAt
      ? Moment(claimdetails.createdAt).tz(tz).format("MM/DD/YYYY")
      : "";

    const resolvedate = claimdetails.resolved_date
      ? Moment(claimdetails.resolved_date).tz(tz).format("MM/DD/YYYY")
      : "";
    const replacements = {
      ["CLAIM_DATE"]: claimdate,
      ["RESOLVE_DATE"]: resolvedate,
      ["ORDER_NAME"]: orderName,
      ["TYPE"]: claimdetails.reason || "Refund",
      ["TOTAL_CLAIM"]: `$${finalPrice}`,
    };

    claimdata += module.exports.replacePlaceholders(template, replacements);
  });

  return claimdata;
}


module.exports = {
  validate: function (rules) {
    return function (req, res, next) {
      var validation = new Validator({ ...req.body, ...req.params }, rules);
      if (validation.fails()) {
        if (!_.isUndefined(req.files) && !_.isEmpty(req.files)) {
          _.each(req.files, function (file) {
            Func.deleteFile(file.path);
          });
        }
        var error = validation.errors.all();
        return next(setError(error[Object.keys(error)[0]][0]));
      } else {
        return next();
      }
    };
  },

  replacePlaceholders: function (template, replacements) {
    let result = template;
    for (const placeholder in replacements) {
      const value = replacements[placeholder];
      result = result.split(`[${placeholder}]`).join(value);
    }
    return result;
  },

  emailValidation: function (email) {
    const emailPattern =
      /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    var lowercaseEmail = email.toLowerCase();
    if (email === lowercaseEmail && emailPattern.test(email)) return true;
    throwError(MSG.INVALID_EMAIL);
  },

  orderValidation: function (order) {
    const orderIdIsNumeric = /^\d+$/.test(order);
    if (orderIdIsNumeric) return true;
    throwError(MSG.INVALID_ORDER);
  },

  passwordValidation: function (password) {
    if (password.length < 8) return false;
    const hasUppercase = /[A-Z]/.test(password);
    const hasLowercase = /[a-z]/.test(password);
    const hasSpecialChar = /[!@#$%^&*()\-=_+{};':"\\|,.<>/?~`[\]]/.test(
      password
    );
    if (hasUppercase && hasLowercase && hasSpecialChar) return true;
    throwError(MSG.PASSWORD_LENGTH);
  },

  /**
   * NOTE: Presigned URL max expiry in SigV4 is 7 days.
   * Old code used 1 year; AWS SDK v3 enforces the 7-day limit.
   */
createPDFandUpload: function (params, statementDetails, statement_id, billingMoment) {

  let { html, options, filePath } = params;
  let path;

  return new Promise(async (resolve, reject) => {
    try {
      path = `${filePath.merchantId}/${filePath.filename}`;

      const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });

      const page = await browser.newPage();
      await page.setContent(html);
      const pdfBuffer = await page.pdf(options);

      // ✅ PRIVATE upload (same as your old behavior)
      await s3.send(
        new PutObjectCommand({
          Bucket: "swipe-statements",
          Key: path,
          Body: pdfBuffer,
          ContentType: "application/pdf",
        })
      );

      // ✅ SAME OLD URL FORMAT (DB unchanged)
      const uploadLocation =
        `https://swipe-statements.s3.${AWS_CREDENTIALS.AWS_REGION}.amazonaws.com/${path}`;

      // ✅ SAVE URL DIRECTLY (NO nested object bug)
      await Services.Statement.findOneAndUpdate(
        { _id: statement_id },
        {
          url: uploadLocation,
          month: billingMoment.month() + 1,
          year: billingMoment.year(),
        },
        { new: true }
      );

      await browser.close();

      resolve(uploadLocation);

    } catch (err) {
      console.error("❌ createPDFandUpload error:", err);
      reject(err);
    }
  });
},


createStatementPdf: async (merchantDetail, lastMonth, billingMoment) => {

    try {
      let statement = await fs.readFileSync("./lib/statement.html", {
        encoding: "utf-8",
      });

      console.log("📄 Creating statement PDF for merchant:", merchantDetail.name);

      let claim = await claimtable(merchantDetail.claim);

      let addressParts = [];
      if (merchantDetail.address) addressParts.push(merchantDetail.address);
      if (merchantDetail.city) addressParts.push(merchantDetail.city);
      if (merchantDetail.province_code)
        addressParts.push(merchantDetail.province_code);
      if (merchantDetail.zip) addressParts.push(merchantDetail.zip);

      let addressLine1 = addressParts.join(", ");
      let addressHtml = `${addressLine1}`;
      if (merchantDetail.country) {
        addressHtml += `<br> ${merchantDetail.country}`;
      }

      function formatCustomNumber(number) {
        let numStr = String(number);
        if (numStr.length > 1) {
          return numStr.slice(0, 1) + "," + numStr.slice(1);
        }
        return numStr;
      }

      const commissionPercent = merchantDetail.competition || 0;
      const totalDueToSwipe = parseFloat(
        merchantDetail.total_due_to_swipe ||
          merchantDetail.total_billed_amount ||
          merchantDetail.current_month_total ||
          merchantDetail.fees_collected ||
          0
      );

      const merchantCommission = (
        (totalDueToSwipe * commissionPercent) /
        100
      ).toFixed(2);
      const totalAfterCommission = (totalDueToSwipe - merchantCommission).toFixed(
        2
      );

      merchantDetail.merchant_commission = merchantCommission;
      merchantDetail.total_after_commission = totalAfterCommission;
      merchantDetail.commission_percent = commissionPercent;

      console.log("✅ Commission Percent:", commissionPercent);
      console.log("✅ Total Due:", totalDueToSwipe);
      console.log("✅ Merchant Commission:", merchantCommission);
      console.log("✅ Total After Commission:", totalAfterCommission);

      let replacements = {
        ["SHOW_OWNER"]: merchantDetail.shop_owner,
        ["MERCHANT_NAME"]: merchantDetail.name,
        ["ADDRESS"]: addressHtml,
        ["STATEMENT_ID"]: merchantDetail.statement_id,
        ["STATEMENT_DATE"]: merchantDetail.statement_date,
        ["CURRENT_MONTH_TOTAL"]: merchantDetail.current_month_total,
        ["FIRST_DATE"]: merchantDetail.first_date,
        ["LAST_DATE"]: merchantDetail.last_date,
       ["FEES_COLLECTION"]: Number(merchantDetail.fees_collected).toLocaleString("en-US", { 
    minimumFractionDigits: 2, 
    maximumFractionDigits: 2 
  }),
        ["TOTAL_CLAIMS"]: (
          merchantDetail.total_refunds + merchantDetail.total_reorders
        ).toLocaleString(),
        ["REFUND"]: `$${merchantDetail.total_refunds.toLocaleString()}`,
        ["REORDER"]: merchantDetail.discount
          ? `$${Number(merchantDetail.total_reorders).toLocaleString("en-US")} 
      <tr> 
        <th style="padding: 2px 0 2px 15px;font-weight:400;text-align:left;">
          Discount(${merchantDetail.discount}%)
        </th> 
        <th style="padding: 2px 0 2px 2px;font-weight:400;text-align:left;">
          $${Number(merchantDetail.discount_amount).toLocaleString("en-US")}
        </th> 
      </tr>`
          : `$${Number(merchantDetail.total_reorders).toLocaleString("en-US")}`,
        ["CLAIM_DATA"]: claim,
        ["CURRENT_MONTH_TOTAL"]: merchantDetail.current_month_total,
        ["TOTAL_BILLED_AMOUNT"]: merchantDetail.total_billed_amount.toLocaleString(),
        ["MERCHANT_INCENTIVE"]: merchantDetail.merchant_incentive,
        ["PROTECTED_REVENUE_PERCENTAGE"]: merchantDetail.attach_rate,
        ["TOTAL_DUE_TO_SWIPE"]: `$${totalDueToSwipe.toLocaleString()}`,
        ["MERCHANT_COMMISSION"]: `$${merchantCommission}`,
        ["TOTAL_AFTER_COMMISSION"]: `$${totalAfterCommission}`,
        ["COMMISSION_PERCENT"]: `${commissionPercent}%`,
        ["PROTECTED_ORDER_VALUE"]: `$${Number(merchantDetail.total_price || 0).toLocaleString("en-US", { 
          minimumFractionDigits: 2, 
          maximumFractionDigits: 2 
        })}`,
        ["ORDERS_PROTECTED"]: Number(merchantDetail.net_items_sold || 0).toLocaleString("en-US"),
        ["ATTACH_RATE"]: merchantDetail.attach_rate || "0.00%",
      };

      statement = await Func.replacePlaceholders(statement, replacements);

      const options = {
        width: "297mm",
        height: "420mm",
        orientation: "landscape",
        zoomFactor: "1",
        header: {
          height: "24px",
          width: "250px",
        },
      };

   await Func.createPDFandUpload(
  {
    html: statement,
    options,
    filePath: {
      merchantId: merchantDetail._id,
      filename: `statement${lastMonth}.pdf`,
    },
  },
  {
    statementDetails: merchantDetail.statement_details,
  },
  merchantDetail.statement_id,
  billingMoment.clone()

);


      console.log("✅ Statement PDF generated successfully!");
      return true;
    } catch (error) {
      console.log("❌ Error in createStatementPdf:", error);
      throwError(error);
    }
  },

  calculatePercentageDifference: (number1, number2) => {
    const difference = number1 - number2;
    if (difference === 0) return "0%";
    const percentageDifference = (difference / Math.max(number1, number2)) * 100;
    return `${percentageDifference.toFixed(2)}%`;
  },

  isAdmin: (role) => {
    return ADMIN_ROLES.includes(role);
  },

  GetFinalPrice: async (orderId) => {
    try {
      const orderInfo = await Services.Order.get({ _id: orderId });
      if (!orderInfo || !orderInfo.line_items) {
        throw new Error("Order not found or has no line items.");
      }

      const updatedLineItems = orderInfo.line_items.map((item) => {
        const price = parseFloat(
          item.price_set?.presentment_money?.amount || item.price || 0
        );
        const totalLineDisc = parseFloat(
          item.total_discount_set?.presentment_money?.amount ||
            item.total_discount ||
            0
        );
        const parsedQty = Number(item.quantity);
        const qty =
          item.quantity == null || !Number.isFinite(parsedQty)
            ? 1
            : Math.max(0, parsedQty);

        const perUnitDisc = qty > 0 ? totalLineDisc / qty : 0;
        const final_price = (price - perUnitDisc).toFixed(2);

        return {
          ...item,
          final_price,
        };
      });

      const final_total_price = updatedLineItems
        .reduce((sum, item) => {
          const parsedQty = Number(item.quantity);
          const qty =
            item.quantity == null || !Number.isFinite(parsedQty)
              ? 1
              : Math.max(0, parsedQty);
          return sum + parseFloat(item.final_price) * qty;
        }, 0)
        .toFixed(2);

      const response = await Services.Order.findOneAndUpdate(
        { _id: orderInfo._id },
        {
          $set: {
            line_items: updatedLineItems,
            final_total_price,
          },
        },
        { new: true }
      );

      return { response };
    } catch (err) {
      console.error("Error in refund calculation:", err);
      throw err;
    }
  },
};
