import browser from "@agent-browser/eve";

export default browser({
  // Web pages are untrusted input; boundary markers keep page text from
  // reading as instructions to the model.
  contentBoundaries: true,
});
