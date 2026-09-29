const { google } = require("googleapis");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_MERCHANT_SHEET_TAB = "Claims";
const DEFAULT_TIME_ZONE = "Asia/Karachi";
const DATA_RANGE = "A:AA";
const LEGACY_INTERNAL_ID_COLUMN = "K";
const STYLED_INTERNAL_ID_COLUMN = "Y";
const STYLED_REFUND_TOTAL_COLUMN = "Z";
const STYLED_REORDER_TOTAL_COLUMN = "AA";
const SHEET_SYNC_VERSION = "pending-rejected-status-v14";
const LEGACY_SHEET_HEADERS = [
    "Order created",
    "Claim created",
    "Order",
    "Customer Name",
    "Customer Email",
    "Merchant",
    "Reason",
    "Note",
    "Refunded/Rordered",
    "status",
    "internal_claim_id",
    "claim closed",
];
const STYLED_SHEET_HEADERS = [
    "Order Date",
    "Claim / Order Number",
    "Status",
    "Claim Date",
    "Merchant",
    "Customer Email",
    "Refund/Reorder Status",
    "Refund/Replace Amount",
    "Notes",
    "Claim Closed",
    ...Array(14).fill(""),
    "internal_claim_id",
    "refund_total",
    "reorder_total",
];
const SHEET_LAYOUT = {
    LEGACY: "legacy",
    STYLED: "styled",
};
const SUMMARY_MARKER = "SUMMARY";
const SUMMARY_MIN_START_ROW = 47;
const TABLE_MIN_END_ROW_INDEX = SUMMARY_MIN_START_ROW - 3;
const STYLED_STATUS_OPTIONS = [
    "In Review",
    "Approved",
    "Resolved",
    "Reject",
];
const STYLED_STATUSES_TO_REFRESH = new Set([
    "",
    "new",
    "in progress",
    "rejected",
    "refunded",
    "reordered",
    "refunded/reordered",
    "replaced",
    "closed",
    "reviewing",
    "approved",
    "resolved",
    "re-ordered",
    "refunded / re-ordered",
]);
const MANAGED_STYLED_STATUSES = new Set([
    ...STYLED_STATUS_OPTIONS.map((status) => status.toLowerCase()),
    ...STYLED_STATUSES_TO_REFRESH,
]);
const GOOGLE_OAUTH_RECONNECT_MESSAGE =
    "Google OAuth Client ID or Client Secret is invalid. Update Google Sheet Settings, reconnect the Google Account, and try again.";

let oauthClient;
let oauthSheetsClient;
let oauthConfigPromise;
const sheetLayoutPromises = new Map();
const sheetTabPromises = new Map();
const merchantSpreadsheetPromises = new Map();
const merchantMonthlyMigrationPromises = new Map();
const claimSyncPromises = new Map();
const styledSheetWritePromises = new Map();
const spreadsheetTablePromises = new Map();

const getGoogleConfigModel = () =>
    global.Models?.GoogleSheetConfig || require("../models/GoogleSheetConfig");

const getClaimModel = () => global.Models?.Claim || require("../models/Claim");

const isValidClaimId = (claimId) => {
    if (global.IsValidObjectId) return global.IsValidObjectId(claimId);
    return require("mongoose").Types.ObjectId.isValid(claimId);
};

const normalizeGoogleApiError = (error) => {
    const status = error?.response?.status || error?.status || error?.code;
    const reason =
        error?.response?.data?.error?.errors?.[0]?.reason ||
        error?.response?.data?.error ||
        error?.response?.data?.error_description;
    const message =
        error?.response?.data?.error?.message ||
        error?.response?.data?.error_description ||
        error?.message ||
        "";
    const requiresReconnect =
        Number(status) === 401 ||
        reason === "invalid_client" ||
        reason === "invalid_grant" ||
        /invalid client|client secret is invalid|invalid grant/i.test(message);

    if (!requiresReconnect) return error;

    const normalizedError = new Error(GOOGLE_OAUTH_RECONNECT_MESSAGE);
    normalizedError.status = 409;
    normalizedError.code = "GOOGLE_OAUTH_RECONNECT_REQUIRED";
    normalizedError.cause = error;
    return normalizedError;
};

const getOAuthConfig = async () => {
    if (!oauthConfigPromise) {
        oauthConfigPromise = getGoogleConfigModel()
            .findOne({ key: "primary" })
            .select("+client_secret +refresh_token")
            .lean()
            .then((config) => {
                if (
                    !config?.client_id?.trim() ||
                    !config?.client_secret?.trim() ||
                    !config?.refresh_token?.trim()
                ) {
                    return null;
                }
                return config;
            })
            .catch((error) => {
                oauthConfigPromise = undefined;
                throw error;
            });
    }

    return oauthConfigPromise;
};

const hasOAuthConfig = async () => Boolean(await getOAuthConfig());

const isConfigured = async () => hasOAuthConfig();

const resetOAuthClient = () => {
    oauthClient = undefined;
    oauthSheetsClient = undefined;
    oauthConfigPromise = undefined;
};

const getOAuthClient = async () => {
    if (oauthClient) return oauthClient;
    const config = await getOAuthConfig();
    if (!config) {
        throw new Error(
            "Google Sheet OAuth credentials are not configured in the database"
        );
    }

    oauthClient = new google.auth.OAuth2({
        clientId: config.client_id.trim(),
        clientSecret: config.client_secret.trim(),
        transporterOptions: { timeout: 30000 },
    });
    oauthClient.setCredentials({
        refresh_token: config.refresh_token.trim(),
    });

    return oauthClient;
};

const getOAuthSheetsClient = async () => {
    if (oauthSheetsClient) return oauthSheetsClient;

    oauthSheetsClient = require("./GoogleSheetApi")(google.sheets({
        version: "v4",
        auth: await getOAuthClient(),
    }));

    return oauthSheetsClient;
};

const getOAuthDriveClient = async () =>
    google.drive({
        version: "v3",
        auth: await getOAuthClient(),
    });

const toCellValue = (value) => {
    if (value === null || value === undefined) return "";
    return String(value);
};

const formatSheetDate = (value) => {
    if (!value) return "";

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    return new Intl.DateTimeFormat("en-GB", {
        timeZone:
            process.env.GOOGLE_SHEET_TIMEZONE?.trim() || DEFAULT_TIME_ZONE,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    }).format(date);
};

const formatStyledSheetDate = (value) => {
    if (!value) return "";

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    return new Intl.DateTimeFormat("en-US", {
        timeZone:
            process.env.GOOGLE_SHEET_TIMEZONE?.trim() || DEFAULT_TIME_ZONE,
        day: "numeric",
        month: "numeric",
        year: "numeric",
    }).format(date);
};

const getClaimMonthSheetTab = (claim = {}) => {
    const data = getClaimData(claim);
    const value =
        data.createdAt || data.claim_created_at || data.updatedAt || new Date();
    const date = value instanceof Date ? value : new Date(value);
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;

    return new Intl.DateTimeFormat("en-US", {
        timeZone:
            process.env.GOOGLE_SHEET_TIMEZONE?.trim() || DEFAULT_TIME_ZONE,
        month: "long",
        year: "numeric",
    }).format(safeDate);
};

const getClaimData = (claim) =>
    typeof claim?.toObject === "function"
        ? claim.toObject({ getters: false, virtuals: false })
        : claim || {};

const toNumericAmount = (value) => {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
};

const getClaimAmounts = (data = {}) => {
    const processedTotal =
        toNumericAmount(data.combined_refund_total) ||
        toNumericAmount(data.swipe_by_refunded) ||
        toNumericAmount(data.claim_total);
    const resolution = toCellValue(data.refund_status).trim().toUpperCase();
    const status = toCellValue(data.status).trim().toUpperCase();
    const isProcessed = status === "APPROVED" || status === "RESOLVED";
    let refundTotal = toNumericAmount(data.refund_total);
    let reorderTotal = toNumericAmount(data.reorder_total);

    if (!isProcessed) {
        return { processedTotal: 0, refundTotal: 0, reorderTotal: 0 };
    }

    if (!refundTotal && resolution === "REFUND") {
        refundTotal = processedTotal;
    }
    if (
        !reorderTotal &&
        (resolution === "REPLACE" || resolution === "REORDER")
    ) {
        reorderTotal = processedTotal;
    }

    return {
        processedTotal:
            processedTotal || refundTotal + reorderTotal,
        refundTotal,
        reorderTotal,
    };
};

const getStyledClaimStatus = (data) => {
    const status = toCellValue(data.status || data.sub_status)
        .trim()
        .toUpperCase();
    if (status === "CLOSED") return "Reject";
    if (status === "REVIEWING" || status === "IN_REVIEW") {
        return "In Review";
    }
    if (status === "APPROVED") return "Approved";
    if (status === "RESOLVED") return "Resolved";
    return "In Review";
};

const getClaimResolutionStatus = (data) => {
    const status = toCellValue(data.status).trim().toUpperCase();
    if (status === "CLOSED") return "Rejected";
    if (status === "APPROVED" || status === "RESOLVED") {
        // Cumulative action totals take priority over refund_status, which can
        // hold the customer's preference or only the most recent action.
        let refundTotal = toNumericAmount(data.refund_total);
        let reorderTotal = toNumericAmount(data.reorder_total);
        if (!(refundTotal > 0) && !(reorderTotal > 0)) {
            ({ refundTotal, reorderTotal } = getClaimAmounts(data));
        }
        if (refundTotal > 0 && reorderTotal > 0) return "Refunded/Reordered";
        if (refundTotal > 0) return "Refunded";
        if (reorderTotal > 0) return "Reordered";
    }
    return "";
};

const mapClaimToLegacyRow = (claim) => {
    const data = getClaimData(claim);
    const status = toCellValue(data.status).toUpperCase();
    const isTerminal = status === "CLOSED" || status === "RESOLVED";
    const sheetStatus = status === "CLOSED" ? "REJECT" : status;
    const processedTotal =
        data.combined_refund_total ??
        data.swipe_by_refunded ??
        data.claim_total;

    return [
        formatSheetDate(
            data.order_snapshot?.created_at ||
                data.order_snapshot?.order_created_at ||
                data.order_created_at
        ),
        formatSheetDate(data.createdAt),
        toCellValue(data.order_name || data.order_snapshot?.name),
        toCellValue(data.order_snapshot?.customer_name),
        toCellValue(data.order_snapshot?.customer_email),
        toCellValue(data.merchant_snapshot?.name),
        toCellValue(data.reason),
        toCellValue(data.description),
        toCellValue(processedTotal),
        sheetStatus,
        toCellValue(data._id),
        isTerminal
            ? formatSheetDate(
                  data.resolved_date || data.closed_at || data.updatedAt
              )
            : "",
    ];
};

const mapClaimToStyledRow = (claim) => {
    const data = getClaimData(claim);
    const status = toCellValue(data.status).toUpperCase();
    const isTerminal = status === "CLOSED" || status === "RESOLVED";
    const { processedTotal, refundTotal, reorderTotal } = getClaimAmounts(data);

    return [
        formatStyledSheetDate(
            data.order_snapshot?.created_at ||
                data.order_snapshot?.order_created_at ||
                data.order_created_at
        ),
        toCellValue(data.order_name || data.order_snapshot?.name),
        getStyledClaimStatus(data),
        formatStyledSheetDate(data.createdAt),
        toCellValue(data.merchant_snapshot?.name),
        toCellValue(data.order_snapshot?.customer_email),
        getClaimResolutionStatus(data),
        processedTotal,
        toCellValue(data.description),
        isTerminal
            ? formatStyledSheetDate(
                  data.resolved_date || data.closed_at || data.updatedAt
              )
            : "",
        ...Array(14).fill(""),
        toCellValue(data._id),
        refundTotal,
        reorderTotal,
    ];
};

const mapClaimToRow = (claim, layout = SHEET_LAYOUT.LEGACY) =>
    layout === SHEET_LAYOUT.STYLED
        ? mapClaimToStyledRow(claim)
        : mapClaimToLegacyRow(claim);

// Mixed pending/original displays need untyped A and D table columns.
// Keep original order and claim dates numeric with explicit date formats.
const preserveStyledDateTypes = (row, layout) => {
    if (layout.type !== SHEET_LAYOUT.STYLED || !layout.pendingCount) return row;
    for (const column of [0, 3]) {
        const match = String(row[column] || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (match) row[column] = (Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])) - Date.UTC(1899, 11, 30)) / 86400000;
    }
    return row;
};

const getStyledSheetHeaders = () => [...STYLED_SHEET_HEADERS];
const getStyledStatusOptions = () => [...STYLED_STATUS_OPTIONS];

const buildSummaryRows = (dataStartRow, summaryStartRow) => [
    [SUMMARY_MARKER, ""],
    [
        "Total Refund",
        `=SUM(${STYLED_REFUND_TOTAL_COLUMN}${dataStartRow}:${STYLED_REFUND_TOTAL_COLUMN})`,
    ],
    [
        "Total Re-Order",
        `=SUM(${STYLED_REORDER_TOTAL_COLUMN}${dataStartRow}:${STYLED_REORDER_TOTAL_COLUMN})`,
    ],
    ["Total", `=B${summaryStartRow + 1}+B${summaryStartRow + 2}`],
];

const getStyledTableColumnProperties = () =>
    STYLED_SHEET_HEADERS.slice(0, 10).map((columnName, columnIndex) => {
        const types = [
            "DATE",
            "TEXT",
            "DROPDOWN",
            "DATE",
            "TEXT",
            "TEXT",
            "TEXT",
            "CURRENCY",
            "TEXT",
            "DATE",
        ];
        const property = {
            columnIndex,
            columnName,
            columnType: types[columnIndex],
        };

        if (property.columnType === "DROPDOWN") {
            property.dataValidationRule = {
                condition: {
                    type: "ONE_OF_LIST",
                    values: STYLED_STATUS_OPTIONS.map((userEnteredValue) => ({
                        userEnteredValue,
                    })),
                },
            };
        }

        return property;
    });

const buildStyledTableDefinition = ({
    tableId,
    name,
    sheetId,
    headerRowIndex,
    lastClaimRow,
}) => ({
    ...(tableId ? { tableId } : {}),
    ...(name ? { name } : {}),
    range: {
        sheetId,
        startRowIndex: headerRowIndex,
        endRowIndex: Math.max(TABLE_MIN_END_ROW_INDEX, lastClaimRow),
        startColumnIndex: 0,
        endColumnIndex: 10,
    },
    rowsProperties: {
        headerColorStyle: {
            rgbColor: { red: 1, green: 0.84, blue: 0 },
        },
        firstBandColorStyle: {
            rgbColor: { red: 1, green: 1, blue: 1 },
        },
        secondBandColorStyle: {
            rgbColor: { red: 0.95, green: 0.96, blue: 0.97 },
        },
    },
    columnProperties: getStyledTableColumnProperties(),
});

const getSheetRange = (sheetTab, cells = DATA_RANGE) =>
    `'${String(sheetTab).replace(/'/g, "''")}'!${cells}`;

const formatSpreadsheetTitle = (merchant = {}) => {
    const merchantName =
        toCellValue(merchant.name || merchant.shop_id || merchant._id).trim() ||
        "Merchant";
    const safeName = merchantName.replace(/[\u0000-\u001f\u007f]/g, " ");
    return `Swipe Claims - ${safeName}`.slice(0, 180);
};

const getMerchantSheetTab = (merchant = {}) =>
    toCellValue(
        merchant.google_sheet_tab ||
            process.env.GOOGLE_MERCHANT_SHEET_TAB ||
            DEFAULT_MERCHANT_SHEET_TAB
    ).trim() || DEFAULT_MERCHANT_SHEET_TAB;

const isMonthlySheetTab = (sheetTab) =>
    /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/.test(
        toCellValue(sheetTab).trim()
    );

const getMerchantModel = () => {
    const Merchant = global.Models?.Merchant;
    if (!Merchant) {
        throw new Error("Merchant model is unavailable for Google Sheet provisioning");
    }
    return Merchant;
};

const getUserModel = () => {
    const User = global.Models?.Users;
    if (!User) {
        throw new Error("User model is unavailable for Google Sheet sharing");
    }
    return User;
};

const getLogger = () => global.Logger || console;

const isMerchantSheetSyncEnabled = (merchant) =>
    merchant?.google_sheet_claim_sync_enabled === true;

const canAdminViewMerchantSheet = (admin, merchantId) => {
    if (
        admin?.role !== "admin" ||
        admin?.is_deleted === true ||
        admin?.disabled === true
    ) {
        return false;
    }

    if (!admin.admin_type || admin.admin_type === "super_admin") return true;
    if (
        admin.admin_type !== "simple_admin" ||
        admin.admin_permissions?.claims_view !== true
    ) {
        return false;
    }

    return (Array.isArray(admin.merchants) ? admin.merchants : []).some(
        (assignedMerchantId) =>
            String(assignedMerchantId) === String(merchantId)
    );
};

const isValidEmailAddress = (value) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

const shareSpreadsheetReadOnlyWithAdmins = async (
    spreadsheetId,
    merchantId
) => {
    try {
        const [admins, config] = await Promise.all([
            getUserModel()
                .find(
                    {
                        role: "admin",
                        is_deleted: { $ne: true },
                        disabled: { $ne: true },
                    },
                    {
                        email: 1,
                        role: 1,
                        admin_type: 1,
                        admin_permissions: 1,
                        merchants: 1,
                        is_deleted: 1,
                        disabled: 1,
                    }
                )
                .lean(),
            getOAuthConfig(),
        ]);
        const ownerEmail = String(config?.connected_email || "")
            .trim()
            .toLowerCase();
        const viewerEmails = [
            ...new Set(
                admins
                    .filter((admin) =>
                        canAdminViewMerchantSheet(admin, merchantId)
                    )
                    .map((admin) => String(admin.email || "").trim().toLowerCase())
                    .filter(
                        (email) =>
                            isValidEmailAddress(email) && email !== ownerEmail
                    )
            ),
        ];
        const drive = await getOAuthDriveClient();
        let sharedCount = 0;

        // Google Drive does not support concurrent permission updates reliably.
        for (const emailAddress of viewerEmails) {
            try {
                await drive.permissions.create({
                    fileId: spreadsheetId,
                    sendNotificationEmail: false,
                    requestBody: {
                        type: "user",
                        role: "reader",
                        emailAddress,
                    },
                });
                sharedCount += 1;
            } catch (error) {
                const message =
                    error?.response?.data?.error?.message ||
                    error?.message ||
                    String(error);
                getLogger().warn(
                    `Unable to grant Google Sheet viewer access to ${emailAddress}: ${message}`
                );
            }
        }

        return { eligibleCount: viewerEmails.length, sharedCount };
    } catch (error) {
        getLogger().warn(
            `Unable to load admins for Google Sheet viewer access: ${
                error?.message || String(error)
            }`
        );
        return { eligibleCount: 0, sharedCount: 0 };
    }
};

const toPlainObject = (value) =>
    typeof value?.toObject === "function"
        ? value.toObject({ getters: false, virtuals: false })
        : value;

const findMerchant = async (merchantOrId) => {
    const input = toPlainObject(merchantOrId);
    const merchantId =
        input && typeof input === "object" ? input._id : input;
    if (!merchantId) return null;

    return getMerchantModel().findById(merchantId).lean();
};

const findClaimMerchant = async (claim = {}) => {
    const Merchant = getMerchantModel();
    const merchantReference = claim.merchant?._id || claim.merchant;

    if (merchantReference) {
        const merchant = await Merchant.findById(merchantReference).lean();
        if (merchant) return merchant;
    }

    const shopId = claim.merchant_snapshot?.shop_id;
    if (shopId) return Merchant.findOne({ shop_id: shopId }).lean();

    return null;
};

const normalizeSheetHeader = (value) =>
    toCellValue(value).trim().toLowerCase().replace(/[_\s]+/g, " ");

const getSheetLayoutFromRows = (rows) => {
    const styledHeaderRowIndex = rows.findIndex((row) => {
        const headers = row.map(normalizeSheetHeader);
        return (
            headers.includes("order date") &&
            headers.includes("claim / order number") &&
            headers.includes("status") &&
            headers.includes("claim date")
        );
    });
    if (styledHeaderRowIndex !== -1) {
        return {
            type: SHEET_LAYOUT.STYLED,
            headerRowIndex: styledHeaderRowIndex,
        };
    }

    const legacyHeaderRowIndex = rows.findIndex((row) => {
        const headers = row.map(normalizeSheetHeader);
        return (
            headers.includes("order created") &&
            headers.includes("claim created") &&
            headers.includes("status")
        );
    });
    if (legacyHeaderRowIndex !== -1) {
        return {
            type: SHEET_LAYOUT.LEGACY,
            headerRowIndex: legacyHeaderRowIndex,
        };
    }

    return null;
};

const sheetColumnName = (index) => {
    let name = "";
    for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) {
        name = String.fromCharCode(65 + (number - 1) % 26) + name;
    }
    return name;
};

const prepareStyledSheetColumns = async ({ sheets, spreadsheetId, sheetId, columnCount }) => {
    // Never insert inside the table: retries or another running app version can
    // otherwise shift both rows and their IDs again. Normalize row values below.
    if (columnCount >= STYLED_SHEET_HEADERS.length) return;
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ appendDimension: {
            sheetId, dimension: "COLUMNS",
            length: STYLED_SHEET_HEADERS.length - columnCount,
        } }] },
    });
};

const styledRowClaimIds = (row = []) => row.flatMap((value, index) =>
    index >= 23 && /^[a-f0-9]{24}$/i.test(toCellValue(value).trim())
        ? [{ claimId: toCellValue(value).trim(), index }]
        : []
);

const normalizeStyledClaimRows = async ({ sheets, spreadsheetId, sheetTab, dataStartRow, columnCount }) => {
    if (columnCount >= 40) {
        const marker = await sheets.spreadsheets.values.get({ spreadsheetId, range: getSheetRange(sheetTab, "AC1") });
        // The independently managed pending table must never be included in
        // a main-table migration or duplicate cleanup.
        if (marker.data.values?.[0]?.[0] === "Previous Months — Pending Claims") columnCount = 28;
    }
    const endColumn = sheetColumnName(columnCount - 1);
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId, range: getSheetRange(sheetTab, `A${dataStartRow}:${endColumn}`),
    });
    const rows = response.data.values || [];
    const byClaimId = new Map();
    rows.forEach((row, offset) => {
        if (/^pending:/i.test(toCellValue(row[24]))) return;
        const ids = styledRowClaimIds(row);
        if (ids.length > 1) throw new Error(`Ambiguous claim IDs in Sheet row ${dataStartRow + offset}; refusing to overwrite it`);
        if (!ids.length) return;
        const { claimId, index } = ids[0];
        const sources = byClaimId.get(claimId) || [];
        sources.push({ row, rowNumber: dataStartRow + offset, idIndex: index });
        byClaimId.set(claimId, sources);
    });
    const affected = [...byClaimId].filter(([, sources]) => sources.length > 1 || sources[0].idIndex !== 24);
    const placeholderRepairs = rows.flatMap((row, offset) => {
        if (!isPlaceholderSheetRow(row) || (!toCellValue(row[6]) && !row.slice(10).some((cell) => toCellValue(cell)))) return [];
        return [{ range: getSheetRange(sheetTab, `G${dataStartRow + offset}:${endColumn}${dataStartRow + offset}`), values: [Array(columnCount - 6).fill("")] }];
    });
    if (!affected.length && !placeholderRepairs.length) return { repairedClaims: 0, clearedRows: 0 };
    const claims = affected.length ? await getClaimModel().find({ _id: { $in: affected.map(([id]) => id) } }).lean() : [];
    const claimsById = new Map(claims.map((claim) => [toCellValue(claim._id), claim]));
    const data = [...placeholderRepairs];
    let clearedRows = 0;
    for (const [id, sources] of affected) {
        const claim = claimsById.get(id);
        if (!claim) throw new Error(`Cannot repair Sheet claim ${id}: claim record unavailable`);
        // Prefer an already aligned row, using the database for the latest
        // outcome and amounts. Keep sheet-edited notes and identifying cells.
        const primary = sources.find((source) => source.idIndex === 24) || sources[0];
        const row = mapClaimToStyledRow(claim);
        for (const index of [0, 1, 3, 4, 5]) row[index] = primary.row[index] ?? row[index];
        row[8] = primary.row[primary.idIndex - 16] ?? row[8];
        row[9] = primary.row[primary.idIndex - 15] || row[9];
        for (const source of sources) {
            const width = Math.max(27, source.idIndex + 3);
            const values = source === primary ? [...row, ...Array(width - 27).fill("")] : Array(width).fill("");
            data.push({
                range: getSheetRange(sheetTab, `A${source.rowNumber}:${sheetColumnName(width - 1)}${source.rowNumber}`),
                values: [values],
            });
            if (source !== primary) clearedRows += 1;
        }
    }
    // One values batch writes the repaired rows and clears their duplicates;
    // no compaction means a stale source can never erase another target row.
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption: "RAW", data },
    });
    if (affected.length) getLogger().info(`[GoogleSheet] Normalized claim rows. version=${SHEET_SYNC_VERSION} tab=${sheetTab} claims=${affected.length} cleared=${clearedRows} ranges=${data.map((entry) => entry.range).join(",")}`);
    return { repairedClaims: affected.length, clearedRows };
};

const repairMixedStyledClaimRows = async ({
    sheets,
    spreadsheetId,
    sheetTab,
    dataStartRow,
}) => {
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: getSheetRange(sheetTab, `A${dataStartRow}:AA`),
    });
    const rows = response.data.values || [];
    const sourceRowsByClaimId = new Map();

    rows.forEach((row, index) => {
        if (/^pending:/i.test(toCellValue(row[24]))) return;
        const claimId = [row?.[24], row?.[23], row?.[9], row?.[10]]
            .map((value) => toCellValue(value).trim())
            .find(isValidClaimId) || "";
        if (!claimId) return;

        const rowNumber = dataStartRow + index;
        const sourceRows = sourceRowsByClaimId.get(claimId) || [];
        sourceRows.push(rowNumber);
        sourceRowsByClaimId.set(claimId, sourceRows);
    });

    const claimIds = [...sourceRowsByClaimId.keys()];
    if (!claimIds.length) return { repairedClaims: 0, clearedRows: 0 };

    const claims = await getClaimModel()
        .find({ _id: { $in: claimIds } })
        .lean();
    const claimsById = new Map(
        claims.map((claim) => [toCellValue(claim._id), claim])
    );
    const orderedClaims = claimIds
        .map((claimId) => claimsById.get(claimId))
        .filter(Boolean);
    if (!orderedClaims.length) {
        return { repairedClaims: 0, clearedRows: 0 };
    }

    // Repair each original where it already lives. Compacting from row 2 can
    // overwrite pending carryovers and unrecognised user content above it.
    const targetRowsByClaimId = new Map(orderedClaims.map((claim) => {
        const id = toCellValue(claim._id);
        const sources = sourceRowsByClaimId.get(id);
        const aligned = sources.find((rowNumber) => toCellValue(rows[rowNumber - dataStartRow]?.[24]) === id);
        return [id, aligned ?? sources[0]];
    }));

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "RAW",
            data: orderedClaims.map((claim) => {
                const rowNumber = targetRowsByClaimId.get(
                    toCellValue(claim._id)
                );
                return {
                    range: getSheetRange(
                        sheetTab,
                        `A${rowNumber}:AA${rowNumber}`
                    ),
                    values: [mapClaimToStyledRow(claim)],
                };
            }),
        },
    });

    const staleRows = [];
    sourceRowsByClaimId.forEach((sourceRows, claimId) => {
        if (!claimsById.has(claimId)) return;
        const targetRow = targetRowsByClaimId.get(claimId);
        sourceRows.forEach((rowNumber) => {
            if (rowNumber !== targetRow && ![...targetRowsByClaimId.values()].includes(rowNumber)) staleRows.push(rowNumber);
        });
    });

    if (staleRows.length) {
        await sheets.spreadsheets.values.batchClear({
            spreadsheetId,
            requestBody: {
                ranges: [...new Set(staleRows)].map((rowNumber) =>
                    getSheetRange(sheetTab, `A${rowNumber}:AA${rowNumber}`)
                ),
            },
        });
    }

    return {
        repairedClaims: orderedClaims.length,
        clearedRows: new Set(staleRows).size,
    };
};

const getSolidBorder = () => ({
    style: "SOLID",
    color: { red: 0.12, green: 0.12, blue: 0.12 },
});

const buildConditionalFormatDeleteRequests = (sheetId, indexes = []) =>
    [...indexes]
        .sort((left, right) => right - left)
        .map((index) => ({
            deleteConditionalFormatRule: { sheetId, index },
        }));

const formatStyledSheetLayout = async ({
    sheets,
    spreadsheetId,
    sheetId,
    headerRowIndex,
    rowCount,
    statusRuleIndexesToDelete,
}) => {
    const dataStartIndex = headerRowIndex + 1;
    const border = getSolidBorder();
    const columnWidths = [134, 144, 163, 117, 243, 228, 185, 111, 102, 99];
    const requests = [
        {
            repeatCell: {
                range: { sheetId, startRowIndex: headerRowIndex, endRowIndex: headerRowIndex + 1, startColumnIndex: 10, endColumnIndex: 24 },
                cell: { userEnteredFormat: {} },
                fields: "userEnteredFormat",
            },
        },
        {
            updateSheetProperties: {
                properties: {
                    sheetId,
                    gridProperties: {
                        frozenRowCount: headerRowIndex === 0 ? 1 : 0,
                    },
                },
                fields: "gridProperties.frozenRowCount",
            },
        },
        {
            repeatCell: {
                range: {
                    sheetId,
                    startRowIndex: dataStartIndex,
                    endRowIndex: rowCount,
                    startColumnIndex: 0,
                    endColumnIndex: 10,
                },
                cell: {
                    userEnteredFormat: {
                        textFormat: { fontFamily: "Arial", fontSize: 10 },
                        verticalAlignment: "MIDDLE",
                    },
                },
                fields: "userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.verticalAlignment",
            },
        },
        {
            repeatCell: {
                range: {
                    sheetId,
                    startRowIndex: headerRowIndex,
                    endRowIndex: headerRowIndex + 1,
                    startColumnIndex: 0,
                    endColumnIndex: 10,
                },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: { red: 1, green: 0.84, blue: 0 },
                        horizontalAlignment: "LEFT",
                        verticalAlignment: "MIDDLE",
                        wrapStrategy: "WRAP",
                        textFormat: {
                            bold: true,
                            fontFamily: "Arial",
                            fontSize: 10,
                            foregroundColor: { red: 0, green: 0, blue: 0 },
                        },
                    },
                },
                fields: "userEnteredFormat",
            },
        },
        {
            updateBorders: {
                range: {
                    sheetId,
                    startRowIndex: headerRowIndex,
                    endRowIndex: headerRowIndex + 1,
                    startColumnIndex: 0,
                    endColumnIndex: 10,
                },
                top: border,
                bottom: border,
                left: border,
                right: border,
                innerVertical: border,
            },
        },
        {
            updateDimensionProperties: {
                range: {
                    sheetId,
                    dimension: "ROWS",
                    startIndex: headerRowIndex,
                    endIndex: headerRowIndex + 1,
                },
                properties: { pixelSize: 55 },
                fields: "pixelSize",
            },
        },
        {
            updateDimensionProperties: {
                range: {
                    sheetId,
                    dimension: "COLUMNS",
                    startIndex: 0,
                    endIndex: 10,
                },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
            },
        },
        {
            updateDimensionProperties: {
                range: {
                    sheetId,
                    dimension: "COLUMNS",
                    startIndex: 24,
                    endIndex: 27,
                },
                properties: { hiddenByUser: true },
                fields: "hiddenByUser",
            },
        },
    ];

    columnWidths.forEach((pixelSize, index) => {
        requests.push({
            updateDimensionProperties: {
                range: {
                    sheetId,
                    dimension: "COLUMNS",
                    startIndex: index,
                    endIndex: index + 1,
                },
                properties: { pixelSize },
                fields: "pixelSize",
            },
        });
    });

    requests.unshift(
        ...buildConditionalFormatDeleteRequests(
            sheetId,
            statusRuleIndexesToDelete
        )
    );

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
    });
};

const backfillMissingStyledStatuses = async ({
    sheets,
    spreadsheetId,
    sheetTab,
    dataStartRow,
}) => {
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: getSheetRange(sheetTab, `C${dataStartRow}:Y`),
    });
    const rows = response.data.values || [];
    const claimRows = rows
        .map((row, index) => ({
            rowNumber: dataStartRow + index,
            status: toCellValue(row?.[0]).trim(),
            resolution: toCellValue(row?.[4]).trim(),
            claimId: toCellValue(row?.[22]).trim(),
        }))
        .filter(({ claimId }) => claimId && isValidClaimId(claimId));

    if (!claimRows.length) return 0;

    const claimIds = claimRows.map(({ claimId }) => claimId);
    const claims = await getClaimModel()
        .find({ _id: { $in: claimIds } })
        .select(
            "status sub_status refund_status combined_refund_total swipe_by_refunded claim_total refund_total reorder_total"
        )
        .lean();
    const claimsById = new Map(
        claims.map((claim) => [toCellValue(claim._id), claim])
    );
    const updates = claimRows.flatMap(({ rowNumber, claimId, status: currentStatus, resolution }) => {
        const claim = claimsById.get(claimId);
        if (!claim) return [];
        const status = getStyledClaimStatus(claim);
        const cellUpdates = [];
        if (STYLED_STATUSES_TO_REFRESH.has(currentStatus.toLowerCase()) && status !== currentStatus) {
            cellUpdates.push({
                range: getSheetRange(sheetTab, `C${rowNumber}`),
                values: [[status]],
            });
        }
        const resolutionStatus = getClaimResolutionStatus(claim);
        if (resolutionStatus !== resolution) {
            cellUpdates.push({
                range: getSheetRange(sheetTab, `G${rowNumber}`),
                values: [[resolutionStatus]],
            });
        }
        return cellUpdates;
    });

    if (!updates.length) return 0;

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "RAW",
            data: updates,
        },
    });

    return updates.length;
};

const withSpreadsheetTableLock = async (spreadsheetId, operation) => {
    const previous =
        spreadsheetTablePromises.get(spreadsheetId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    spreadsheetTablePromises.set(spreadsheetId, current);

    try {
        return await current;
    } finally {
        if (spreadsheetTablePromises.get(spreadsheetId) === current) {
            spreadsheetTablePromises.delete(spreadsheetId);
        }
    }
};

const getMonthlySheetSortKey = (sheetTab) => {
    const match = toCellValue(sheetTab).match(
        /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/
    );
    if (!match) return Number.POSITIVE_INFINITY;
    const monthIndex = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ].indexOf(match[1]);
    return Number(match[2]) * 12 + monthIndex;
};

const getStyledTableName = (allSheets, targetSheet) => {
    const targetTitle = targetSheet.properties?.title || "Claims";
    if (!isMonthlySheetTab(targetTitle)) {
        return `${targetTitle.replace(/[^A-Za-z0-9]/g, "") || "Claims"}Table`;
    }

    const monthlySheets = allSheets
        .filter((sheet) => isMonthlySheetTab(sheet.properties?.title))
        .sort(
            (left, right) =>
                getMonthlySheetSortKey(left.properties?.title) -
                getMonthlySheetSortKey(right.properties?.title)
        );
    return `Table${monthlySheets.indexOf(targetSheet) + 1}`;
};

const applyStyledTableFinishing = async ({
    sheets,
    spreadsheetId,
    sheetId,
    sheetTab,
    headerRowIndex,
    tableEndRowIndex,
}) => {
    const dataStartRow = headerRowIndex + 2;
    const lastTableRow = tableEndRowIndex;
    const [visibleResponse, idResponse] = await Promise.all([
        sheets.spreadsheets.values.get({
            spreadsheetId,
            range: getSheetRange(
                sheetTab,
                `A${dataStartRow}:J${lastTableRow}`
            ),
        }),
        sheets.spreadsheets.values.get({
            spreadsheetId,
            range: getSheetRange(
                sheetTab,
                `${STYLED_INTERNAL_ID_COLUMN}${dataStartRow}:${STYLED_INTERNAL_ID_COLUMN}${lastTableRow}`
            ),
        }),
    ]);
    const visibleRows = visibleResponse.data.values || [];
    const idRows = idResponse.data.values || [];
    const placeholderColumns = new Map([
        [1, "Claim / Order Number"],
        [3, "m/d/yyyy"],
        [7, "$xx"],
        [8, "Notes"],
        [9, "m/d/yyyy"],
    ]);
    const valueUpdates = [];
    const formattingRequests = [
        {
            repeatCell: {
                range: {
                    sheetId,
                    startRowIndex: headerRowIndex,
                    endRowIndex: headerRowIndex + 1,
                    startColumnIndex: 0,
                    endColumnIndex: 10,
                },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: { red: 1, green: 0.84, blue: 0 },
                        horizontalAlignment: "LEFT",
                        verticalAlignment: "MIDDLE",
                        wrapStrategy: "WRAP",
                        textFormat: {
                            bold: true,
                            italic: false,
                            fontFamily: "Arial",
                            fontSize: 10,
                            foregroundColor: { red: 0, green: 0, blue: 0 },
                        },
                    },
                },
                fields: "userEnteredFormat",
            },
        },
        {
            updateBorders: {
                range: {
                    sheetId,
                    startRowIndex: headerRowIndex,
                    endRowIndex: tableEndRowIndex,
                    startColumnIndex: 0,
                    endColumnIndex: 10,
                },
                top: getSolidBorder(),
                bottom: getSolidBorder(),
                left: getSolidBorder(),
                right: getSolidBorder(),
                innerHorizontal: getSolidBorder(),
                innerVertical: getSolidBorder(),
            },
        },
    ];

    for (let rowNumber = dataStartRow; rowNumber <= lastTableRow; rowNumber += 1) {
        const rowOffset = rowNumber - dataStartRow;
        const isPendingRow = /^pending:[a-f0-9]{24}$/i.test(toCellValue(idRows[rowOffset]?.[0]).trim());
        if (isPendingRow) {
            formattingRequests.push(
                { repeatCell: { range: { sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "M/d/yyyy" }, horizontalAlignment: "RIGHT" } }, fields: "userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment" } },
                { repeatCell: { range: { sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: 7, endColumnIndex: 8 }, cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } }, fields: "userEnteredFormat.numberFormat" } },
                { repeatCell: { range: { sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: 0, endColumnIndex: 10 }, cell: { userEnteredFormat: { backgroundColor: rowOffset % 2 ? { red: 0.95, green: 0.96, blue: 0.97 } : { red: 1, green: 1, blue: 1 }, textFormat: { italic: false, foregroundColorStyle: { rgbColor: { red: 0, green: 0, blue: 0 } } } } }, fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.italic,userEnteredFormat.textFormat.foregroundColorStyle" } },
                { repeatCell: { range: { sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: 3, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "M/d/yyyy" }, backgroundColor: { red: 232 / 255, green: 240 / 255, blue: 254 / 255 }, textFormat: { foregroundColorStyle: { rgbColor: { red: 26 / 255, green: 115 / 255, blue: 232 / 255 } } } } }, fields: "userEnteredFormat.numberFormat,userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.foregroundColorStyle" } },
                { repeatCell: { range: { sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { backgroundColor: { red: 232 / 255, green: 240 / 255, blue: 254 / 255 }, textFormat: { foregroundColorStyle: { rgbColor: { red: 26 / 255, green: 115 / 255, blue: 232 / 255 } } } } }, fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.foregroundColorStyle" } },
            );
            continue;
        }
        const hasClaimId = Boolean(toCellValue(idRows[rowOffset]?.[0]).trim());
        formattingRequests.push({
            repeatCell: {
                range: {
                    sheetId,
                    startRowIndex: rowNumber - 1,
                    endRowIndex: rowNumber,
                    startColumnIndex: 0,
                    endColumnIndex: 10,
                },
                cell: {
                    userEnteredFormat: {
                        textFormat: {
                            italic: false,
                            foregroundColor: { red: 0, green: 0, blue: 0 },
                        },
                    },
                },
                fields: "userEnteredFormat.textFormat.italic,userEnteredFormat.textFormat.foregroundColor",
            },
        });
        if (hasClaimId) {
            for (const column of [0, 3]) formattingRequests.push({ repeatCell: { range: { sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: column, endColumnIndex: column + 1 }, cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "M/d/yyyy" } } }, fields: "userEnteredFormat.numberFormat" } });
            continue;
        }

        placeholderColumns.forEach((placeholder, columnIndex) => {
            const currentValue = toCellValue(
                visibleRows[rowOffset]?.[columnIndex]
            ).trim();
            if (!currentValue || currentValue === placeholder) {
                valueUpdates.push({
                    range: getSheetRange(
                        sheetTab,
                        `${String.fromCharCode(65 + columnIndex)}${rowNumber}`
                    ),
                    values: [[placeholder]],
                });
            }
            formattingRequests.push({
                repeatCell: {
                    range: {
                        sheetId,
                        startRowIndex: rowNumber - 1,
                        endRowIndex: rowNumber,
                        startColumnIndex: columnIndex,
                        endColumnIndex: columnIndex + 1,
                    },
                    cell: {
                        userEnteredFormat: {
                            textFormat: {
                                italic: true,
                                foregroundColor: {
                                    red: 0.34,
                                    green: 0.36,
                                    blue: 0.39,
                                },
                            },
                        },
                    },
                    fields: "userEnteredFormat.textFormat.italic,userEnteredFormat.textFormat.foregroundColor",
                },
            });
        });
    }

    if (valueUpdates.length) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: "RAW",
                data: valueUpdates,
            },
        });
    }
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: formattingRequests },
    });
};

const ensureStyledTable = async ({
    sheets,
    spreadsheetId,
    sheetId,
    sheetTab,
    headerRowIndex,
    lastClaimRow,
    allowMonthLabels = false,
}) =>
    withSpreadsheetTableLock(spreadsheetId, async () => {
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: "sheets(properties(sheetId,title),tables(tableId,name,range,columnProperties))",
        });
        const allSheets = spreadsheet.data.sheets || [];
        const targetSheet = allSheets.find(
            (sheet) => sheet.properties?.sheetId === sheetId
        );
        if (!targetSheet) {
            throw new Error(`Google Sheet tab ID not found: ${sheetId}`);
        }

        const existingTable = (targetSheet.tables || []).find(
            (table) =>
                table.range?.startRowIndex === headerRowIndex &&
                table.range?.startColumnIndex === 0
        );
        const desiredName = getStyledTableName(allSheets, targetSheet);
        const conflictingTable = allSheets
            .flatMap((sheet) => sheet.tables || [])
            .find(
                (table) =>
                    table.name === desiredName &&
                    table.tableId !== existingTable?.tableId
            );
        if (conflictingTable) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [
                        {
                            updateTable: {
                                table: {
                                    tableId: conflictingTable.tableId,
                                    name: `SwipeTable${conflictingTable.tableId}`,
                                },
                                fields: "name",
                            },
                        },
                    ],
                },
            });
        }
        let table;
        let request;

        if (existingTable) {
            table = buildStyledTableDefinition({
                tableId: existingTable.tableId,
                name: desiredName,
                sheetId,
                headerRowIndex,
                lastClaimRow,
            });
            request = {
                updateTable: {
                    table,
                    fields: "name,range,rowsProperties,columnProperties",
                },
            };
        } else {
            table = buildStyledTableDefinition({
                name: desiredName,
                sheetId,
                headerRowIndex,
                lastClaimRow,
            });
            request = { addTable: { table } };
        }

        if (allowMonthLabels) for (const column of [0, 3]) table.columnProperties[column].columnType = "COLUMN_TYPE_UNSPECIFIED";
        const response = await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [request] },
        });
        await sheets.spreadsheets.values.clear({
            spreadsheetId,
            range: getSheetRange(
                sheetTab,
                `K${headerRowIndex + 1}:X${headerRowIndex + 1}`
            ),
            requestBody: {},
        });
        await applyStyledTableFinishing({
            sheets,
            spreadsheetId,
            sheetId,
            sheetTab,
            headerRowIndex,
            tableEndRowIndex: table.range.endRowIndex,
        });

        return {
            action: existingTable ? "updated" : "created",
            tableId:
                existingTable?.tableId ||
                response.data.replies?.[0]?.addTable?.table?.tableId,
            name: table.name,
        };
    });

const syncStyledSummary = async ({
    sheets,
    spreadsheetId,
    sheetTab,
    sheetId,
    dataStartRow,
}) => {
    const [summaryResponse, idResponse] = await Promise.all([
        sheets.spreadsheets.values.get({
            spreadsheetId,
            range: getSheetRange(sheetTab, "A:B"),
        }),
        sheets.spreadsheets.values.get({
            spreadsheetId,
            range: getSheetRange(
                sheetTab,
                `${STYLED_INTERNAL_ID_COLUMN}${dataStartRow}:${STYLED_INTERNAL_ID_COLUMN}`
            ),
        }),
    ]);
    const summaryRows = summaryResponse.data.values || [];
    const idRows = idResponse.data.values || [];
    const pendingCount = idRows.filter((row) => /^pending:[a-f0-9]{24}$/i.test(toCellValue(row?.[0]))).length;
    const oldSummaryIndex = summaryRows.findIndex(
        (row) => toCellValue(row?.[0]).trim().toUpperCase() === SUMMARY_MARKER
    );
    let lastClaimRow = dataStartRow - 1;

    idRows.forEach((row, index) => {
        if (toCellValue(row?.[0]).trim()) {
            lastClaimRow = dataStartRow + index;
        }
    });

    const summaryStartRow = Math.max(
        SUMMARY_MIN_START_ROW,
        lastClaimRow + 3
    );
    const oldSummaryStartRow =
        oldSummaryIndex === -1 ? null : oldSummaryIndex + 1;

    if (oldSummaryStartRow && oldSummaryStartRow !== summaryStartRow) {
        await sheets.spreadsheets.values.clear({
            spreadsheetId,
            range: getSheetRange(
                sheetTab,
                `A${oldSummaryStartRow}:B${oldSummaryStartRow + 3}`
            ),
            requestBody: {},
        });
    }

    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: getSheetRange(
            sheetTab,
            `A${summaryStartRow}:B${summaryStartRow + 3}`
        ),
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: buildSummaryRows(dataStartRow, summaryStartRow),
        },
    });

    const border = getSolidBorder();
    const requests = [];
    if (oldSummaryStartRow && oldSummaryStartRow !== summaryStartRow) {
        requests.push({
            repeatCell: {
                range: {
                    sheetId,
                    startRowIndex: oldSummaryStartRow - 1,
                    endRowIndex: oldSummaryStartRow + 3,
                    startColumnIndex: 0,
                    endColumnIndex: 2,
                },
                cell: { userEnteredFormat: {} },
                fields: "userEnteredFormat",
            },
        });
    }

    requests.push(
        {
            repeatCell: {
                range: {
                    sheetId,
                    startRowIndex: summaryStartRow - 1,
                    endRowIndex: summaryStartRow,
                    startColumnIndex: 0,
                    endColumnIndex: 2,
                },
                cell: {
                    userEnteredFormat: {
                        horizontalAlignment: "CENTER",
                        textFormat: { bold: true, fontSize: 14 },
                    },
                },
                fields: "userEnteredFormat",
            },
        },
        {
            repeatCell: {
                range: {
                    sheetId,
                    startRowIndex: summaryStartRow,
                    endRowIndex: summaryStartRow + 3,
                    startColumnIndex: 1,
                    endColumnIndex: 2,
                },
                cell: {
                    userEnteredFormat: {
                        numberFormat: {
                            type: "CURRENCY",
                            pattern: "$#,##0.00",
                        },
                    },
                },
                fields: "userEnteredFormat.numberFormat",
            },
        },
        {
            repeatCell: {
                range: {
                    sheetId,
                    startRowIndex: summaryStartRow,
                    endRowIndex: summaryStartRow + 1,
                    startColumnIndex: 1,
                    endColumnIndex: 2,
                },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: { red: 0.7, green: 0.84, blue: 0.64 },
                    },
                },
                fields: "userEnteredFormat.backgroundColor",
            },
        },
        {
            repeatCell: {
                range: {
                    sheetId,
                    startRowIndex: summaryStartRow + 1,
                    endRowIndex: summaryStartRow + 2,
                    startColumnIndex: 1,
                    endColumnIndex: 2,
                },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: { red: 0.58, green: 0.73, blue: 0.88 },
                    },
                },
                fields: "userEnteredFormat.backgroundColor",
            },
        },
        {
            repeatCell: {
                range: {
                    sheetId,
                    startRowIndex: summaryStartRow + 2,
                    endRowIndex: summaryStartRow + 3,
                    startColumnIndex: 1,
                    endColumnIndex: 2,
                },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: { red: 0.88, green: 0.76, blue: 0.83 },
                        textFormat: { bold: true },
                    },
                },
                fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold",
            },
        },
        {
            updateBorders: {
                range: {
                    sheetId,
                    startRowIndex: summaryStartRow - 1,
                    endRowIndex: summaryStartRow + 3,
                    startColumnIndex: 0,
                    endColumnIndex: 2,
                },
                top: border,
                bottom: border,
                left: border,
                right: border,
                innerHorizontal: border,
                innerVertical: border,
            },
        }
    );

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
    });

    await ensureStyledTable({
        sheets,
        spreadsheetId,
        sheetId,
        sheetTab,
        headerRowIndex: dataStartRow - 2,
        lastClaimRow,
        allowMonthLabels: pendingCount > 0,
    });

    return { summaryStartRow, lastClaimRow, pendingCount };
};

const ensureSheetLayoutUnlocked = async ({ sheets, spreadsheetId, sheetTab }, { forClaimUpdate = false } = {}) => {
    const layoutKey = `${spreadsheetId}:${sheetTab}:${forClaimUpdate ? "claim" : "layout"}`;
    if (sheetLayoutPromises.has(layoutKey)) {
        return sheetLayoutPromises.get(layoutKey);
    }

    const layoutPromise = (async () => {
        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: getSheetRange(sheetTab, "A1:Z"),
        });
        const rows = headerResponse.data.values || [];
        let detectedLayout = getSheetLayoutFromRows(rows);
        let createdStyledLayout = false;
        let needsMixedLayoutRepair = false;

        const detectedHeaders = detectedLayout
            ? (rows[detectedLayout.headerRowIndex] || []).map(
                  normalizeSheetHeader
              )
            : [];
        if (
            detectedLayout?.type === SHEET_LAYOUT.LEGACY ||
            (detectedLayout?.type === SHEET_LAYOUT.STYLED &&
                detectedHeaders.includes("customer name"))
        ) {
            needsMixedLayoutRepair = true;
            detectedLayout = {
                type: SHEET_LAYOUT.STYLED,
                headerRowIndex: detectedLayout.headerRowIndex,
            };
        }

        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: "sheets(properties,conditionalFormats,tables)",
        });
        const targetSheet = spreadsheet.data.sheets?.find(
            (sheet) => sheet.properties?.title === sheetTab
        );
        if (targetSheet?.properties?.sheetId === undefined) {
            throw new Error(`Google Sheet tab not found: ${sheetTab}`);
        }
        const mainTable = targetSheet.tables?.find((table) =>
            (table.range?.startRowIndex || 0) === 0 && (table.range?.startColumnIndex || 0) === 0 && table.range?.endColumnIndex === 10);
        const originalIds = rows.slice(1).flatMap((row) => /^pending:/i.test(toCellValue(row[24])) ? [] : styledRowClaimIds(row));
        const canonicalHeaders = STYLED_SHEET_HEADERS.slice(0, 26).every((header, index) => normalizeSheetHeader(rows[0]?.[index]) === normalizeSheetHeader(header));
        if (forClaimUpdate && detectedLayout?.headerRowIndex === 0 && canonicalHeaders && mainTable &&
            targetSheet.properties.gridProperties.columnCount >= 27 && originalIds.every((entry) => entry.index === 24) &&
            new Set(originalIds.map((entry) => entry.claimId)).size === originalIds.length) {
            // An ordinary refund/reorder save needs no header rewrite, table
            // recreation, row migration or placeholder backfill.
            return {
                type: SHEET_LAYOUT.STYLED, headerRow: 1, dataStartRow: 2,
                internalIdColumn: STYLED_INTERNAL_ID_COLUMN, internalIdIndex: 24,
                endColumn: "AA", sheetId: targetSheet.properties.sheetId,
                pendingCount: rows.filter((row) => /^pending:[a-f0-9]{24}$/i.test(toCellValue(row[24]))).length,
            };
        }
        await prepareStyledSheetColumns({
            sheets,
            spreadsheetId,
            sheetId: targetSheet.properties.sheetId,
            headerRowIndex: detectedLayout?.headerRowIndex || 0,
            headers: needsMixedLayoutRepair ? [] : detectedHeaders,
            columnCount: targetSheet.properties.gridProperties?.columnCount || 26,
        });

        if (detectedLayout?.type === SHEET_LAYOUT.STYLED && !needsMixedLayoutRepair) {
            await normalizeStyledClaimRows({
                sheets, spreadsheetId, sheetTab,
                dataStartRow: detectedLayout.headerRowIndex + 2,
                columnCount: Math.max(27, targetSheet.properties.gridProperties?.columnCount || 26),
            });
        }

        if (!detectedLayout) {
            createdStyledLayout = true;
            detectedLayout = {
                type: SHEET_LAYOUT.STYLED,
                headerRowIndex: 0,
            };
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: getSheetRange(sheetTab, "A1:AA1"),
                valueInputOption: "RAW",
                requestBody: {
                    values: [STYLED_SHEET_HEADERS],
                },
            });
        }

        const { type, headerRowIndex } = detectedLayout;
        const internalIdColumn =
            type === SHEET_LAYOUT.STYLED
                ? STYLED_INTERNAL_ID_COLUMN
                : LEGACY_INTERNAL_ID_COLUMN;
        const internalIdIndex =
            type === SHEET_LAYOUT.STYLED ? 24 : 10;
        const expectedHeaders =
            type === SHEET_LAYOUT.STYLED
                ? STYLED_SHEET_HEADERS
                : LEGACY_SHEET_HEADERS;

        if (needsMixedLayoutRepair) {
            await repairMixedStyledClaimRows({
                sheets,
                spreadsheetId,
                sheetTab,
                dataStartRow: headerRowIndex + 2,
            });
        }

        if (type === SHEET_LAYOUT.STYLED && !createdStyledLayout) {
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: getSheetRange(
                    sheetTab,
                    `A${headerRowIndex + 1}:AA${headerRowIndex + 1}`
                ),
                valueInputOption: "RAW",
                requestBody: { values: [STYLED_SHEET_HEADERS] },
            });
        }

        if (
            !createdStyledLayout &&
            normalizeSheetHeader(rows[headerRowIndex]?.[internalIdIndex]) !==
                "internal claim id"
        ) {
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: getSheetRange(
                    sheetTab,
                    `${internalIdColumn}${headerRowIndex + 1}`
                ),
                valueInputOption: "RAW",
                requestBody: {
                    values: [[expectedHeaders[internalIdIndex]]],
                },
            });
        }

        const layout = {
            type,
            headerRow: headerRowIndex + 1,
            dataStartRow: headerRowIndex + 2,
            internalIdColumn,
            internalIdIndex,
            endColumn: type === SHEET_LAYOUT.STYLED ? "AA" : "L",
            sheetId: targetSheet.properties.sheetId,
        };

        if (type === SHEET_LAYOUT.STYLED) {
            const statusRuleIndexesToDelete = (
                targetSheet.conditionalFormats || []
            ).flatMap((rule, index) => {
                    const condition = rule?.booleanRule?.condition;
                    if (condition?.type !== "TEXT_EQ") return [];
                    const statuses = (condition.values || [])
                        .map((value) => value?.userEnteredValue)
                        .filter(Boolean)
                        .map((status) => status.toLowerCase());
                    return statuses.some((status) =>
                        MANAGED_STYLED_STATUSES.has(status)
                    )
                        ? [index]
                        : [];
                });
            await formatStyledSheetLayout({
                sheets,
                spreadsheetId,
                sheetId: layout.sheetId,
                headerRowIndex,
                rowCount:
                    targetSheet.properties.gridProperties?.rowCount || 1000,
                statusRuleIndexesToDelete,
            });
            const summary = await syncStyledSummary({
                sheets,
                spreadsheetId,
                sheetTab,
                sheetId: layout.sheetId,
                dataStartRow: layout.dataStartRow,
            });
            layout.pendingCount = summary.pendingCount;
            await backfillMissingStyledStatuses({
                sheets,
                spreadsheetId,
                sheetTab,
                dataStartRow: layout.dataStartRow,
            });
        } else {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [
                        {
                            updateDimensionProperties: {
                                range: {
                                    sheetId: layout.sheetId,
                                    dimension: "COLUMNS",
                                    startIndex: 10,
                                    endIndex: 11,
                                },
                                properties: {
                                    hiddenByUser: true,
                                },
                                fields: "hiddenByUser",
                            },
                        },
                    ],
                },
            });
        }

        return layout;
    })().finally(() => {
        sheetLayoutPromises.delete(layoutKey);
    });

    sheetLayoutPromises.set(layoutKey, layoutPromise);
    return layoutPromise;
};

const ensureSheetLayout = (target) =>
    withStyledSheetWriteLock(target, () => ensureSheetLayoutUnlocked(target));

const ensureSpreadsheetTab = async ({ sheets, spreadsheetId, sheetTab }) => {
    const tabKey = `${spreadsheetId}:${sheetTab}`;
    if (sheetTabPromises.has(tabKey)) return sheetTabPromises.get(tabKey);

    const tabPromise = (async () => {
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: "sheets.properties(sheetId,title,index)",
        });
        const existingSheet = spreadsheet.data.sheets?.find(
            (sheet) => sheet.properties?.title === sheetTab
        );
        if (existingSheet) return existingSheet.properties;

        try {
            const response = await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [
                        {
                            addSheet: {
                                properties: {
                                    title: sheetTab,
                                    index: 0,
                                },
                            },
                        },
                    ],
                },
            });
            return response.data.replies?.[0]?.addSheet?.properties || {
                title: sheetTab,
            };
        } catch (error) {
            const message =
                error?.response?.data?.error?.message || error?.message || "";
            if (!/already exists/i.test(message)) throw error;

            const refreshed = await sheets.spreadsheets.get({
                spreadsheetId,
                fields: "sheets.properties(sheetId,title,index)",
            });
            const createdSheet = refreshed.data.sheets?.find(
                (sheet) => sheet.properties?.title === sheetTab
            );
            if (!createdSheet) throw error;
            return createdSheet.properties;
        }
    })().finally(() => sheetTabPromises.delete(tabKey));

    sheetTabPromises.set(tabKey, tabPromise);
    return tabPromise;
};

const getMonthlyClaimTarget = async (claim, target) => {
    const sheetTab = getClaimMonthSheetTab(claim);
    const monthlyTarget = { ...target, sheetTab };
    await ensureSpreadsheetTab(monthlyTarget);
    return monthlyTarget;
};

const getStoredMerchantTarget = async (merchant) => {
    if (!merchant?.google_sheet_id) return null;

    return {
        sheets: await getOAuthSheetsClient(),
        spreadsheetId: merchant.google_sheet_id,
        sheetTab: getMerchantSheetTab(merchant),
        source: "merchant",
    };
};

const provisionMerchantSpreadsheet = async (merchant) => {
    const Merchant = getMerchantModel();
    const sheets = await getOAuthSheetsClient();
    const sheetTab = getMerchantSheetTab(merchant);
    let spreadsheetId;

    try {
        const response = await sheets.spreadsheets.create({
            requestBody: {
                properties: {
                    title: formatSpreadsheetTitle(merchant),
                },
                sheets: [
                    {
                        properties: {
                            title: sheetTab,
                        },
                    },
                ],
            },
        });

        spreadsheetId = response.data.spreadsheetId;
        if (!spreadsheetId) {
            throw new Error("Google Sheets API did not return a spreadsheet ID");
        }

        const spreadsheetUrl =
            response.data.spreadsheetUrl ||
            `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
        const target = {
            sheets,
            spreadsheetId,
            sheetTab,
            source: "merchant",
        };

        await Merchant.updateOne(
            { _id: merchant._id },
            {
                $set: {
                    google_sheet_id: spreadsheetId,
                    google_sheet_url: spreadsheetUrl,
                    google_sheet_tab: sheetTab,
                    google_sheet_status: "provisioning",
                    google_sheet_created_at: new Date(),
                },
                $unset: {
                    google_sheet_error: 1,
                    google_sheet_monthly_tabs_migrated_at: 1,
                },
            }
        );

        await ensureSheetLayout(target);
        await shareSpreadsheetReadOnlyWithAdmins(
            spreadsheetId,
            merchant._id
        );

        await Merchant.updateOne(
            { _id: merchant._id, google_sheet_id: spreadsheetId },
            {
                $set: {
                    google_sheet_status: "ready",
                },
                $unset: {
                    google_sheet_error: 1,
                },
            }
        );

        await migrateMerchantClaimsToMonthlyTabs(merchant, target);

        return target;
    } catch (error) {
        const message =
            error?.response?.data?.error?.message ||
            error?.message ||
            String(error);

        await Merchant.updateOne(
            { _id: merchant._id },
            {
                $set: {
                    google_sheet_status: "error",
                    google_sheet_error: message.slice(0, 1000),
                    ...(spreadsheetId ? { google_sheet_id: spreadsheetId } : {}),
                },
            }
        ).catch(() => {});

        throw error;
    }
};

const ensureMerchantSpreadsheet = async (merchantOrId) => {
    if (!(await hasOAuthConfig())) {
        throw new Error("Google OAuth is not configured for merchant Sheets");
    }

    const merchant = await findMerchant(merchantOrId);
    if (!merchant?._id) throw new Error("Merchant not found for Google Sheet");

    const storedTarget = await getStoredMerchantTarget(merchant);
    if (storedTarget) {
        try {
            await ensureSheetLayout(storedTarget);
            await shareSpreadsheetReadOnlyWithAdmins(
                storedTarget.spreadsheetId,
                merchant._id
            );
            await migrateMerchantClaimsToMonthlyTabs(merchant, storedTarget);
            return storedTarget;
        } catch (error) {
            throw normalizeGoogleApiError(error);
        }
    }

    const merchantKey = String(merchant._id);
    if (merchantSpreadsheetPromises.has(merchantKey)) {
        return merchantSpreadsheetPromises.get(merchantKey);
    }

    const provisioningPromise = provisionMerchantSpreadsheet(merchant)
        .catch((error) => {
            throw normalizeGoogleApiError(error);
        })
        .finally(() => merchantSpreadsheetPromises.delete(merchantKey));
    merchantSpreadsheetPromises.set(merchantKey, provisioningPromise);

    return provisioningPromise;
};

const repairMerchantSpreadsheet = async (merchantOrId) => {
    const merchant = await findMerchant(merchantOrId);
    if (
        !merchant?._id ||
        !merchant.google_sheet_id ||
        !isMerchantSheetSyncEnabled(merchant)
    ) {
        return { action: "skipped" };
    }

    const target = await getStoredMerchantTarget(merchant);
    const layout = await ensureSheetLayout(target);
    const migration = await migrateMerchantClaimsToMonthlyTabs(
        merchant,
        target
    );
    const spreadsheet = await target.sheets.spreadsheets.get({
        spreadsheetId: target.spreadsheetId,
        fields: "sheets.properties(title,index)",
    });
    const monthlyTabs = (spreadsheet.data.sheets || [])
        .map((sheet) => sheet.properties?.title)
        .filter(isMonthlySheetTab);

    for (const sheetTab of monthlyTabs) {
        await ensureSheetLayout({ ...target, sheetTab });
    }

    return {
        action: "repaired",
        layout: layout.type,
        migration,
        monthlyTabs,
    };
};

const deleteMerchantSpreadsheet = async (merchantOrId) => {
    if (!(await hasOAuthConfig())) {
        throw new Error("Google OAuth is not configured for merchant Sheets");
    }

    const Merchant = getMerchantModel();
    const merchant = await findMerchant(merchantOrId);
    if (!merchant?._id) throw new Error("Merchant not found for Google Sheet");

    const spreadsheetId = merchant.google_sheet_id;
    let movedToTrash = false;

    if (spreadsheetId) {
        try {
            const drive = await getOAuthDriveClient();
            await drive.files.update({
                fileId: spreadsheetId,
                requestBody: { trashed: true },
                fields: "id,trashed",
            });
            movedToTrash = true;
        } catch (error) {
            const status = error?.response?.status || error?.code;
            if (status !== 404 && status !== 410) {
                throw normalizeGoogleApiError(error);
            }
        }
    }

    await Merchant.updateOne(
        { _id: merchant._id },
        {
            $set: { google_sheet_claim_sync_enabled: false },
            $unset: {
                google_sheet_id: "",
                google_sheet_url: "",
                google_sheet_tab: "",
                google_sheet_status: "",
                google_sheet_error: "",
                google_sheet_created_at: "",
                google_sheet_monthly_tabs_migrated_at: "",
            },
        }
    );

    if (spreadsheetId) {
        for (const key of sheetLayoutPromises.keys()) {
            if (key.startsWith(`${spreadsheetId}:`)) {
                sheetLayoutPromises.delete(key);
            }
        }
    }
    merchantSpreadsheetPromises.delete(String(merchant._id));

    return {
        hadSpreadsheet: Boolean(spreadsheetId),
        movedToTrash,
    };
};

const resolveClaimTarget = async (
    claim,
    { provisionMerchantSheet = true } = {}
) => {
    if (!(await hasOAuthConfig())) {
        throw new Error("Google OAuth is not configured for merchant Sheets");
    }

    const merchant = await findClaimMerchant(claim);
    if (!merchant || !isMerchantSheetSyncEnabled(merchant)) return null;
    if (merchant.google_sheet_id) return getStoredMerchantTarget(merchant);
    if (provisionMerchantSheet) return ensureMerchantSpreadsheet(merchant);

    return null;
};

const withPersistentSheetLock = async (key, operation) => {
    const db = global.Models?.Claim?.db;
    // Unit tests use in-memory models. Connected application workers share the
    // same Mongo lease, so lookup + append cannot race across server processes.
    if (!db) return operation();
    const locks = db.collection("google_sheet_sync_locks");
    const owner = require("node:crypto").randomUUID();
    const leaseMs = 120000;
    const deadline = Date.now() + 30000;
    let acquired = false;
    while (!acquired && Date.now() < deadline) {
        try {
            const result = await locks.findOneAndUpdate(
                { _id: key, expiresAt: { $lte: new Date() } },
                { $set: { owner, expiresAt: new Date(Date.now() + leaseMs) } },
                { upsert: true, returnDocument: "after" }
            );
            acquired = (result?.value || result)?.owner === owner;
        } catch (error) {
            if (error.code !== 11000) throw error;
        }
        if (!acquired) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!acquired) throw new Error("Google Sheet sync is busy; retry the claim sync");
    const renewal = setInterval(() => {
        locks.updateOne({ _id: key, owner }, { $set: { expiresAt: new Date(Date.now() + leaseMs) } })
            .catch((error) => getLogger().error(`[GoogleSheet] Could not renew sheet sync lock: ${error.message}`));
    }, 30000);
    renewal.unref?.();
    try {
        return await operation();
    } finally {
        clearInterval(renewal);
        await locks.deleteOne({ _id: key, owner });
    }
};

const withStyledSheetWriteLock = async (target, operation) => {
    const sheetKey = `${target.spreadsheetId}:${target.sheetTab}`;
    const previous = styledSheetWritePromises.get(sheetKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => withPersistentSheetLock(sheetKey, operation));
    styledSheetWritePromises.set(sheetKey, current);

    try {
        return await current;
    } finally {
        if (styledSheetWritePromises.get(sheetKey) === current) {
            styledSheetWritePromises.delete(sheetKey);
        }
        for (const key of sheetTabPromises.keys()) {
            if (key.startsWith(`${target.spreadsheetId}:`)) {
                sheetTabPromises.delete(key);
            }
        }
        spreadsheetTablePromises.delete(target.spreadsheetId);
    }
};

const writeClaimsToMonthlyTarget = async (claims, target) => {
    const { sheets, spreadsheetId, sheetTab } = target;
    const layout = await ensureSheetLayout(target);
    if (layout.type !== SHEET_LAYOUT.STYLED) {
        throw new Error(`Monthly Google Sheet tab is not styled: ${sheetTab}`);
    }

    return withStyledSheetWriteLock(target, async () => {
        const idResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: getSheetRange(
                sheetTab,
                `${layout.internalIdColumn}${layout.dataStartRow}:${layout.internalIdColumn}`
            ),
        });
        const idRows = idResponse.data.values || [];
        const rowByClaimId = new Map();
        layout.pendingCount = idRows.filter((row) => /^pending:[a-f0-9]{24}$/i.test(toCellValue(row?.[0]))).length;
        const occupiedRows = new Set();

        idRows.forEach((row, index) => {
            const claimId = toCellValue(row?.[0]).trim();
            if (!claimId) return;
            const rowNumber = layout.dataStartRow + index;
            occupiedRows.add(rowNumber);
            if (!rowByClaimId.has(claimId)) {
                rowByClaimId.set(claimId, rowNumber);
            }
        });

        let nextAvailableRow = layout.dataStartRow;
        const updates = claims.map((claim) => {
            const claimId = toCellValue(claim?._id).trim();
            let rowNumber = rowByClaimId.get(claimId);
            if (!rowNumber) {
                while (occupiedRows.has(nextAvailableRow)) {
                    nextAvailableRow += 1;
                }
                rowNumber = nextAvailableRow;
                occupiedRows.add(rowNumber);
                rowByClaimId.set(claimId, rowNumber);
                nextAvailableRow += 1;
            }

            return {
                range: getSheetRange(
                    sheetTab,
                    `A${rowNumber}:${layout.endColumn}${rowNumber}`
                ),
                values: [preserveStyledDateTypes(mapClaimToStyledRow(claim), layout)],
            };
        });

        if (updates.length) {
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId,
                requestBody: {
                    valueInputOption: "RAW",
                    data: updates,
                },
            });
        }

        await syncStyledSummary({
            sheets,
            spreadsheetId,
            sheetTab,
            sheetId: layout.sheetId,
            dataStartRow: layout.dataStartRow,
        });

        return { writtenClaims: updates.length };
    });
};

const clearMigratedClaimsFromTarget = async (target, claimIds) => {
    if (!claimIds.size) return { clearedRows: 0 };

    const { sheets, spreadsheetId, sheetTab } = target;
    const layout = await ensureSheetLayout(target);
    if (layout.type !== SHEET_LAYOUT.STYLED) return { clearedRows: 0 };

    return withStyledSheetWriteLock(target, async () => {
        const idResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: getSheetRange(
                sheetTab,
                `${layout.internalIdColumn}${layout.dataStartRow}:${layout.internalIdColumn}`
            ),
        });
        const ranges = (idResponse.data.values || []).flatMap((row, index) => {
            const claimId = toCellValue(row?.[0]).trim();
            if (!claimIds.has(claimId)) return [];
            const rowNumber = layout.dataStartRow + index;
            return [getSheetRange(sheetTab, `A${rowNumber}:AA${rowNumber}`)];
        });

        if (ranges.length) {
            await sheets.spreadsheets.values.batchClear({
                spreadsheetId,
                requestBody: { ranges },
            });
        }

        await syncStyledSummary({
            sheets,
            spreadsheetId,
            sheetTab,
            sheetId: layout.sheetId,
            dataStartRow: layout.dataStartRow,
        });

        return { clearedRows: ranges.length };
    });
};

const migrateMerchantClaimsToMonthlyTabs = async (merchantOrId, target) => {
    const merchant = await findMerchant(merchantOrId);
    if (!merchant?._id || merchant.google_sheet_monthly_tabs_migrated_at) {
        return { action: "skipped" };
    }

    const merchantKey = String(merchant._id);
    if (merchantMonthlyMigrationPromises.has(merchantKey)) {
        return merchantMonthlyMigrationPromises.get(merchantKey);
    }

    const migrationPromise = (async () => {
        const claims = await getClaimModel()
            .find({
                merchant: merchant._id,
                google_sheet_sync_enabled: true,
            })
            .sort({ createdAt: 1, _id: 1 })
            .lean();
        const claimsByMonth = new Map();

        claims.forEach((claim) => {
            const sheetTab = getClaimMonthSheetTab(claim);
            const monthlyClaims = claimsByMonth.get(sheetTab) || [];
            monthlyClaims.push(claim);
            claimsByMonth.set(sheetTab, monthlyClaims);
        });

        for (const [sheetTab, monthlyClaims] of claimsByMonth) {
            const monthlyTarget = { ...target, sheetTab };
            await ensureSpreadsheetTab(monthlyTarget);
            await writeClaimsToMonthlyTarget(monthlyClaims, monthlyTarget);
        }

        const migratedClaimIds = new Set(
            claims.map((claim) => toCellValue(claim._id).trim())
        );
        const baseCleanup = await clearMigratedClaimsFromTarget(
            target,
            migratedClaimIds
        );
        const migratedAt = new Date();
        await getMerchantModel().updateOne(
            { _id: merchant._id, google_sheet_id: target.spreadsheetId },
            { $set: { google_sheet_monthly_tabs_migrated_at: migratedAt } }
        );

        return {
            action: "migrated",
            migratedClaims: claims.length,
            monthlyTabs: [...claimsByMonth.keys()],
            clearedBaseRows: baseCleanup.clearedRows,
        };
    })().finally(() => {
        merchantMonthlyMigrationPromises.delete(merchantKey);
    });

    merchantMonthlyMigrationPromises.set(merchantKey, migrationPromise);
    return migrationPromise;
};

const shouldAppendMissingClaim = (claim) =>
    claim?.google_sheet_sync_enabled === true;

const syncClaimRow = async (claim, { appendIfMissing }) => {
    const baseTarget = await resolveClaimTarget(claim, {
        provisionMerchantSheet: appendIfMissing,
    });

    if (!baseTarget) {
        return {
            action: "skipped",
            reason: "merchant_sheet_not_started",
        };
    }

    const target = await getMonthlyClaimTarget(claim, baseTarget);

    const result = await syncClaimRowToTarget(claim, target, { appendIfMissing });
    await syncMerchantPendingClaims(claim.merchant?._id || claim.merchant);
    return result;
};

const isPlaceholderSheetRow = (row = []) => {
    const placeholders = new Set(["", "Claim / Order Number", "m/d/yyyy", "$xx", "Notes"]);
    return row.every((value) => placeholders.has(toCellValue(value).trim()));
};

// Blank cells within a leading carryover block belong to that block, even
// when a damaged row has lost its hidden ID. New originals must go below it.
const firstOriginalRowIndex = (rows) => rows.findLastIndex((row) => /^pending:[a-f0-9]{24}$/i.test(toCellValue(row?.[24]))) + 1;

const restoreMissingMonthlyClaims = async (claim, target, layout, rows) => {
    const merchantId = claim.merchant?._id || claim.merchant;
    if (!merchantId || !isMonthlySheetTab(target.sheetTab)) return 0;
    const monthKey = getMonthlySheetSortKey(target.sheetTab);
    const year = Math.floor(monthKey / 12);
    const month = monthKey % 12;
    // Widen the UTC bounds by a day, then use the configured sheet timezone
    // to select the exact month. Only explicitly opted-in claims are restored.
    const claims = await getClaimModel().find({
        merchant: merchantId,
        google_sheet_sync_enabled: true,
        createdAt: {
            $gte: new Date(Date.UTC(year, month, 0)),
            $lt: new Date(Date.UTC(year, month + 1, 2)),
        },
    }).lean();
    const presentIds = new Set(rows.map((row) => toCellValue(row?.[layout.internalIdIndex])));
    const missing = claims.filter((record) =>
        record.google_sheet_sync_enabled === true &&
        toCellValue(record.merchant?._id || record.merchant) === toCellValue(merchantId) &&
        getClaimMonthSheetTab(record) === target.sheetTab &&
        toCellValue(record._id) !== toCellValue(claim._id) &&
        !presentIds.has(toCellValue(record._id))
    );
    const firstOriginalIndex = firstOriginalRowIndex(rows);
    const data = missing.map((record) => {
        let index = rows.findIndex((row, index) => index >= firstOriginalIndex && isPlaceholderSheetRow(row));
        if (index === -1) index = rows.length;
        const row = preserveStyledDateTypes(mapClaimToStyledRow(record), layout);
        rows[index] = row;
        const rowNumber = layout.dataStartRow + index;
        return {
            range: getSheetRange(target.sheetTab, `A${rowNumber}:${layout.endColumn}${rowNumber}`),
            values: [row],
        };
    });
    if (data.length) {
        await target.sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: target.spreadsheetId,
            requestBody: { valueInputOption: "RAW", data },
        });
        getLogger().info(`[GoogleSheet] Restored missing rows. version=${SHEET_SYNC_VERSION} pid=${process.pid} count=${data.length} tab=${target.sheetTab}`);
    }
    return data.length;
};

const syncClaimRowToTarget = (claim, target, { appendIfMissing = false } = {}) =>
    withStyledSheetWriteLock(target, async () => {
        const { sheets, spreadsheetId, sheetTab } = target;
        const layout = await ensureSheetLayoutUnlocked(target, { forClaimUpdate: true });
        if (global.Models?.Claim?.db) {
            const currentClaims = await getClaimModel().find({ _id: claim._id }).lean();
            const currentClaim = currentClaims.find((record) => toCellValue(record._id) === toCellValue(claim._id));
            if (!currentClaim) throw new Error("Cannot sync a claim whose database record is missing");
            claim = currentClaim;
        }
        const row = preserveStyledDateTypes(mapClaimToRow(claim, layout.type), layout);
        const claimId = row[layout.internalIdIndex];
        if (!claimId) throw new Error("Cannot update Google Sheet row without a claim ID");
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: getSheetRange(sheetTab, `A${layout.dataStartRow}:${layout.endColumn}`),
        });
        const rows = response.data.values || [];
        const restoredCount = await restoreMissingMonthlyClaims(claim, target, layout, rows);
        const previousIds = rows.map((existing) => toCellValue(existing?.[layout.internalIdIndex])).filter(Boolean);
        let index = rows.findIndex((existing) => toCellValue(existing?.[layout.internalIdIndex]) === claimId);
        const isNew = index === -1;
        if (isNew && !appendIfMissing) return { action: "skipped", reason: "claim_not_created_for_merchant_sheet" };
        if (isNew) {
            // A missing ID does not make an occupied row safe to overwrite.
            const firstOriginalIndex = firstOriginalRowIndex(rows);
            index = rows.findIndex((existing, offset) => offset >= firstOriginalIndex && isPlaceholderSheetRow(existing));
            if (index === -1) index = rows.length;
        }
        const rowNumber = layout.dataStartRow + index;
        const result = await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: getSheetRange(sheetTab, `A${rowNumber}:${layout.endColumn}${rowNumber}`),
            valueInputOption: "RAW", requestBody: { values: [row] },
        });
        if (isNew || restoredCount) await syncStyledSummary({
            sheets, spreadsheetId, sheetTab, sheetId: layout.sheetId,
            dataStartRow: layout.dataStartRow,
        });
        const verification = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: getSheetRange(sheetTab, `A${layout.dataStartRow}:${layout.endColumn}`),
        });
        const verifiedIds = (verification.data.values || []).map((existing) => toCellValue(existing?.[layout.internalIdIndex])).filter(Boolean);
        if (verifiedIds.filter((id) => id === claimId).length !== 1 || previousIds.some((id) => !verifiedIds.includes(id))) {
            throw new Error("Google Sheet changed during sync; claim rows did not pass read-back verification");
        }
        getLogger().info(`[GoogleSheet] Verified write. version=${SHEET_SYNC_VERSION} pid=${process.pid} claim_id=${claimId} range=${getSheetRange(sheetTab, `A${rowNumber}:${layout.endColumn}${rowNumber}`)} action=${isNew ? "appended" : "updated"}`);
        return { ...result.data, action: isNew ? "appended" : "updated" };
    });

const withClaimSyncLock = async (claim, operation) => {
    const claimKey = toCellValue(claim?._id);
    if (!claimKey) return operation();

    const previous = claimSyncPromises.get(claimKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    claimSyncPromises.set(claimKey, current);

    try {
        return await current;
    } finally {
        if (claimSyncPromises.get(claimKey) === current) {
            claimSyncPromises.delete(claimKey);
        }
    }
};

const appendClaimRow = async (claim) =>
    withClaimSyncLock(claim, () =>
        syncClaimRow(claim, {
            appendIfMissing: shouldAppendMissingClaim(claim),
        })
    );

const updateClaimRow = async (claim) =>
    withClaimSyncLock(claim, () =>
        syncClaimRow(claim, {
            appendIfMissing: shouldAppendMissingClaim(claim),
        })
    );

const pendingClaims = require("./GoogleSheetPending")({
    getClaimModel, getMerchantModel, findMerchant, getStoredMerchantTarget,
    hasOAuthConfig, isMerchantSheetSyncEnabled, getClaimMonthSheetTab,
    getMonthlySheetSortKey, isMonthlySheetTab, mapClaimToStyledRow,
    ensureSpreadsheetTab, ensureSheetLayoutUnlocked, withStyledSheetWriteLock,
    getSheetRange, getLogger,
});
const syncMerchantPendingClaims = pendingClaims.syncMerchantPendingClaims;

module.exports = {
    syncMerchantPendingClaims,
    syncPendingClaimsToTarget: pendingClaims.syncPendingClaimsToTarget,
    refreshMonthlyPendingClaims: pendingClaims.refreshMonthlyPendingClaims,
    syncVersion: SHEET_SYNC_VERSION,
    appendClaimRow,
    backfillMissingStyledStatuses,
    buildStyledTableDefinition,
    buildSummaryRows,
    buildConditionalFormatDeleteRequests,
    canAdminViewMerchantSheet,
    deleteMerchantSpreadsheet,
    ensureMerchantSpreadsheet,
    ensureSheetLayout,
    ensureSpreadsheetTab,
    formatSheetDate,
    formatSpreadsheetTitle,
    getMerchantSheetTab,
    getClaimMonthSheetTab,
    getStyledSheetHeaders,
    getStyledStatusOptions,
    hasOAuthConfig,
    isConfigured,
    isMerchantSheetSyncEnabled,
    mapClaimToRow,
    mapClaimToStyledRow,
    migrateMerchantClaimsToMonthlyTabs,
    normalizeGoogleApiError,
    normalizeStyledClaimRows,
    repairMerchantSpreadsheet,
    repairMixedStyledClaimRows,
    resetOAuthClient,
    shouldAppendMissingClaim,
    updateClaimRow,
    syncClaimRowToTarget,
};

global.Logger?.info?.(`[GoogleSheet] Writer loaded. version=${SHEET_SYNC_VERSION} pid=${process.pid} source=${__filename}`);
