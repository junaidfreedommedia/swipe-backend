function isMissingHintIndexError(error) {
  const message = String(error?.message || "");
  return (
    error?.codeName === "BadValue" &&
    message.includes("hint provided does not correspond to an existing index")
  );
}

async function runWithOptionalHint(buildQuery, hintName, context = "mongoose query") {
  try {
    return await buildQuery(hintName);
  } catch (error) {
    if (!isMissingHintIndexError(error)) throw error;

    console.warn(
      `[mongo] Missing index for hint "${hintName}" in ${context}; retrying without hint.`
    );
    return buildQuery();
  }
}

module.exports = {
  isMissingHintIndexError,
  runWithOptionalHint,
};
