// Embedded OSA sources survive eve bundling. User values enter only through argv.
// Apple JXA reference: developer.apple.com/library/archive/releasenotes/InterapplicationCommunication/RN-JavaScriptForAutomation/Articles/OSX10-10.html
const prelude = String.raw`
function cut(value, max) { return String(value === null || value === undefined ? "" : value).slice(0, max); }
function iso(value) { return value.toISOString(); }
function fail(code) { var error = new Error(code); error.jarvisCode = code; throw error; }
function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    return JSON.stringify({ok: true, data: perform(input)});
  } catch (error) {
    var code = error.jarvisCode || (Number(error.errorNumber) === -1743 ? "permission_denied" : "apple_error");
    return JSON.stringify({ok: false, code: code});
  }
}
`;

const mail = String.raw`
function header(message, accountId) {
  var result = {messageId: message.id(), subject: cut(message.subject(), 500), sender: cut(message.sender(), 500), receivedAt: iso(message.dateReceived())};
  if (accountId !== undefined) result.accountId = accountId;
  return result;
}
function requireAccount(app, accountId) {
  if (accountId === undefined) return;
  var matches = app.accounts.whose({id: accountId});
  if (matches.length !== 1 || !matches[0].enabled()) fail("account_unavailable");
}
function inAccount(message, accountId) {
  if (accountId === undefined) return true;
  // Resolve only ownership metadata before reading any subject, sender or body.
  try { return String(message.mailbox().account().id()) === accountId; }
  catch (error) { fail("account_unavailable"); }
}
function perform(input) {
  var app = Application("com.apple.mail");
  if (input.action === "list_accounts") {
    var count = app.accounts.length;
    var accounts = [];
    for (var i = 0; i < Math.min(count, 20); i++) {
      var account = app.accounts[i];
      var addresses = account.emailAddresses();
      accounts.push({accountId: cut(account.id(), 256), name: cut(account.name(), 256), enabled: account.enabled(), addresses: addresses.slice(0, 10).map(function(v) { return cut(v, 320); })});
    }
    return {accounts: accounts, truncated: count > 20};
  }
  if (input.action === "list_inbox") {
    requireAccount(app, input.accountId);
    var candidates = app.inbox.messages.whose({dateReceived: {_greaterThanEquals: new Date(input.since)}});
    var count = candidates.length;
    var messages = [];
    var scanned = 0;
    var scanLimit = input.accountId === undefined ? input.limit : 1000;
    for (; scanned < Math.min(count, scanLimit) && messages.length < input.limit; scanned++) {
      var message = candidates[scanned];
      if (inAccount(message, input.accountId)) messages.push(header(message, input.accountId));
    }
    messages.sort(function(a, b) { return b.receivedAt.localeCompare(a.receivedAt); });
    var result = {messages: messages, truncated: scanned < count, ordering: "Bounded native inbox selection, sorted by date; not an exhaustive newest-first search."};
    if (input.accountId !== undefined) result.accountId = input.accountId;
    return result;
  }
  if (input.action === "read_message") {
    requireAccount(app, input.accountId);
    var candidates = app.inbox.messages.whose({id: input.messageId});
    if (candidates.length > 1000) fail("message_not_found");
    var matches = [];
    for (var i = 0; i < candidates.length; i++) if (inAccount(candidates[i], input.accountId)) matches.push(candidates[i]);
    if (matches.length !== 1) fail("message_not_found");
    var message = matches[0];
    var result = header(message, input.accountId);
    var content = String(message.content());
    result.body = cut(content, 16000);
    result.truncated = content.length > 16000;
    return result;
  }
  if (input.action === "send") {
    var accounts = app.accounts.whose({id: input.accountId});
    if (accounts.length !== 1 || !accounts[0].enabled()) fail("account_unavailable");
    if (accounts[0].emailAddresses().indexOf(input.from) < 0) fail("sender_not_in_account");
    if (app.alwaysBccMyself() || app.alwaysCcMyself()) fail("mail_auto_copy");
    var message = app.OutgoingMessage({sender: input.from, subject: input.subject, content: input.body, visible: false});
    app.outgoingMessages.push(message);
    for (var i = 0; i < input.to.length; i++) message.toRecipients.push(app.ToRecipient({address: input.to[i]}));
    // Refuse Mail preferences that silently add recipients, signatures or attachments.
    if (message.ccRecipients.length || message.bccRecipients.length || message.content.attachments.length || message.toRecipients.length !== input.to.length) fail("mail_content_changed");
    for (var i = 0; i < input.to.length; i++) if (message.toRecipients[i].address() !== input.to[i]) fail("mail_content_changed");
    var actualSender = String(message.sender()).replace(/^.*<([^<>]+)>$/, "$1");
    if (message.subject() !== input.subject || String(message.content()) !== input.body || actualSender !== input.from) fail("mail_content_changed");
    if (app.send(message) !== true) fail("send_not_confirmed");
    return {status: "submitted", delivery: "unconfirmed"};
  }
  fail("unsupported");
}
`;

// Calendar event construction/query follows Apple's Calendar Scripting Guide.
const calendar = String.raw`
function perform(input) {
  var app = Application("com.apple.iCal");
  if (input.action === "list_calendars") {
    var count = app.calendars.length;
    var calendars = [];
    for (var i = 0; i < Math.min(count, 30); i++) {
      var calendar = app.calendars[i];
      calendars.push({calendarId: cut(calendar.id(), 256), name: cut(calendar.name(), 256), writable: calendar.writable()});
    }
    return {calendars: calendars, truncated: count > 30};
  }
  var matches = app.calendars.whose({id: input.calendarId});
  if (matches.length !== 1) fail("calendar_not_found");
  var calendar = matches[0];
  if (input.action === "list_events") {
    var matches = calendar.events.whose({_and: [{startDate: {_lessThan: new Date(input.end)}}, {endDate: {_greaterThan: new Date(input.start)}}]});
    var count = matches.length;
    var events = [];
    for (var i = 0; i < Math.min(count, input.limit); i++) {
      var event = matches[i];
      events.push({eventId: cut(event.uid(), 256), title: cut(event.summary(), 500), start: iso(event.startDate()), end: iso(event.endDate()), allDay: event.alldayEvent(), location: cut(event.location(), 500)});
    }
    events.sort(function(a, b) { return a.start.localeCompare(b.start); });
    return {events: events, truncated: count > input.limit, recurrence: "Native stored events only; recurring occurrences are not expanded."};
  }
  if (input.action === "create_event") {
    if (!calendar.writable()) fail("calendar_read_only");
    var event = app.Event({summary: input.title, startDate: new Date(input.start), endDate: new Date(input.end), description: input.notes, location: input.location, alldayEvent: false});
    calendar.events.push(event);
    return {status: "created", eventId: cut(event.uid(), 256)};
  }
  fail("unsupported");
}
`;

const messageServices = String.raw`
function perform(input) {
  var app = Application("com.apple.MobileSMS");
  var services = app.services.whose({serviceType: "iMessage"});
  var count = services.length;
  var result = [];
  for (var i = 0; i < Math.min(count, 10); i++) result.push({serviceId: cut(services[i].id(), 256), name: cut(services[i].name(), 256)});
  return {services: result, truncated: count > 10};
}
`;

const messageSend = String.raw`
on run argv
  tell application "Messages"
    set selectedServices to every service whose id is (item 1 of argv) and service type is iMessage
    if (count of selectedServices) is not 1 then error "Configured iMessage service unavailable" number 10001
    set targetService to item 1 of selectedServices
    set targetBuddy to buddy (item 2 of argv) of targetService
    send (item 3 of argv) to targetBuddy
  end tell
  return "{\"ok\":true,\"data\":{\"status\":\"submitted\",\"delivery\":\"unconfirmed\"}}"
end run
`;

export const appleScripts = Object.freeze({
  mail: { language: "JavaScript", source: prelude + mail },
  calendar: { language: "JavaScript", source: prelude + calendar },
  message_services: { language: "JavaScript", source: prelude + messageServices },
  message_send: { language: "AppleScript", source: messageSend },
});

export type AppleScriptName = keyof typeof appleScripts;
