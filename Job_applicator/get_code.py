#!/usr/bin/env python3
"""get_code.py — read the latest portal confirmation code out of Gmail.

Runbook step 5 ("Email confirmation") was the one interactive step left in an
otherwise unattended run: a Workday or iCIMS signup mails a 4-8 digit code and
the run stopped to ask a human for it. This closes that.

  ./get_code.py                       newest code from the last 10 minutes
  ./get_code.py --from workday        only mail whose From/Subject matches
  ./get_code.py --wait 180            poll until one arrives, then print it
  ./get_code.py --since 5             only mail newer than 5 minutes

Prints the bare code on stdout and nothing else, so a driver can capture it:

  CODE=$(./get_code.py --from myworkday --wait 180) || exit 2

Exit: 0 a code was printed · 2 nothing matched · 1 connection/auth failure.

Credentials come from login.env -> email (gitignored). READ ONLY: this opens
the mailbox with readonly=True, so nothing is ever marked read, moved or
deleted. The code is printed and never written to a log, an answers file or
cache -- same no-echo rule as every other credential in login.env.
"""
import argparse
import email
import email.utils
import imaplib
import json
import os
import re
import sys
import time
from email.header import decode_header, make_header

BASE = os.path.dirname(os.path.abspath(__file__))

# Codes are NOT always digits. Greenhouse mails an 8-character mixed-case
# alphanumeric ("QD0A6WzG"), which a digits-only pattern misses completely --
# that is exactly how the first ClickHouse submit stalled. So: a standalone
# 4-10 character alphanumeric token that contains at least one digit. The digit
# requirement is what keeps ordinary words ("field", "application") out, and
# every real code format seen so far satisfies it.
TOKEN_RE = re.compile(r'(?<![A-Za-z0-9])([A-Za-z0-9]{4,10})(?![A-Za-z0-9])')

# Where a code is announced. Scanning forward from the label is far more robust
# than one regex trying to span the gap, because the code usually sits on its
# own line an unpredictable distance below the sentence.
LABEL_RE = re.compile(
    r'(?:verification|confirmation|security|access|one[- ]time|single[- ]use|login|passcode)'
    r'[\s\w]{0,24}?code|code[\s\w]{0,24}?(?:is|:)|paste\s+this\s+code|enter\s+the\s+code', re.I)

# How far past a label a code may sit. Wide enough for "…field on your
# application:\n\n\nQD0A6WzG", tight enough that a footer address is out of reach.
LABEL_WINDOW = 140

# "18th" in a street address and "1st" in a date both contain digits and would
# otherwise read as codes.
ORDINAL = re.compile(r'^\d{1,2}(st|nd|rd|th)$', re.I)

# Everything below a mail's footer is address and boilerplate, and it is where
# the near-misses live: Greenhouse signs off with "18 West 18th Street, 11th
# Floor, New York, NY 10011", and 10011 was returned as a code for the one
# ClickHouse mail whose real code ("KzPobdun") held no digit. Cut the footer off
# before scanning rather than trying to out-filter it token by token.
FOOTER = re.compile(r'©|\(c\)\s*\d{4}|copyright\s+\d{4}|unsubscribe'
                    r'|\d+\s+\w+\s+\d+(st|nd|rd|th)\s+street', re.I)


def strip_footer(text):
    m = FOOTER.search(text)
    return text[:m.start()] if m else text

NOISE = re.compile(r'\b(unsubscribe|do not reply to this)\b', re.I)

# "code" is not enough on its own. The generic LABELLED[1] pattern matched a
# promo code in an Uber Eats marketing mail on the third live test, so any of
# these immediately in front of the word disqualifies the hit.
BAD_CODE = re.compile(r'(promo|coupon|discount|offer|referral|invite|zip|postal'
                      r'|area|country|dial|qr|bar|error|dress|source|swift|iata)'
                      r'\W{0,3}$', re.I)

# A bare 4-digit run in the 1900-2099 range is a year, not a code. The first
# live test proved this: an unrelated Google "Security alert" yielded 2026 out
# of its copyright footer. Returning a wrong code is worse than returning none,
# because the run types it into a portal and burns the real one's window.
YEARISH = re.compile(r'^(19|20)\d{2}$')


def creds():
    try:
        cfg = json.load(open(os.path.join(BASE, 'login.env')))['email']
        return cfg['imap_host'], int(cfg.get('imap_port', 993)), cfg['user'], cfg['app_password']
    except (OSError, KeyError, ValueError) as exc:
        sys.exit(f'get_code: no usable login.env -> email ({exc})')


def body_text(msg):
    """Flatten a message to text. HTML-only mail is the common case for portals."""
    parts = []
    for part in msg.walk() if msg.is_multipart() else [msg]:
        if part.get_content_maintype() != 'text':
            continue
        try:
            raw = part.get_payload(decode=True) or b''
            txt = raw.decode(part.get_content_charset() or 'utf-8', 'replace')
        except (LookupError, ValueError):
            continue
        if part.get_content_subtype() == 'html':
            txt = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', txt, flags=re.S | re.I)
            txt = re.sub(r'<[^>]+>', ' ', txt)
        parts.append(txt)
    return re.sub(r'[ \t\xa0]+', ' ', '\n'.join(parts))


def extract(text, loose=False):
    """A code from `text`, or None.

    Labelled patterns only by default. The bare digit scan is opt-in (--loose)
    because on real mail it is wrong more often than right: the first two live
    tests pulled a copyright year and then Google's street number ("1600
    Amphitheatre Parkway") out of unrelated footers. A mail that actually
    carries a confirmation code says so in words, so the labelled patterns lose
    nothing real -- and returning None costs one interactive prompt, while
    returning 1600 burns the real code's expiry window on a wrong guess.
    """
    text = strip_footer(text)
    for lab in LABEL_RE.finditer(text):
        if BAD_CODE.search(text[max(0, lab.start() - 20):lab.start()]):
            continue                           # "promo code 2608", not our code
        window = text[lab.end():lab.end() + LABEL_WINDOW]
        tok = first_token(window)
        if tok:
            return tok
    # "483920 is your code" puts the value before the label, so the forward
    # scan above never sees it.
    m = re.search(r'(?<![A-Za-z0-9])([A-Za-z0-9]{4,10})(?![A-Za-z0-9])'
                  r'\s+is\s+your[\s\w]{0,24}?code', text, re.I)
    if m and plausible(m.group(1)):
        return m.group(1)
    if not loose:
        return None
    return first_token(text)


def plausible(tok):
    """A token that could be a code: has a digit, is not a year or an ordinal."""
    if not any(c.isdigit() for c in tok):
        return False
    if YEARISH.match(tok) or ORDINAL.match(tok):
        return False
    return True


def code_shaped(tok):
    """Looks deliberately generated rather than like an English word.

    A digit anywhere qualifies. So does interior capitalisation ("KzPobdun"),
    which is what a Greenhouse code with no digit in it looks like. A plain
    Capitalised word ("Saketh") has its only uppercase at position 0 and is
    rejected, which is the whole point of testing tok[1:] rather than tok.
    """
    if ORDINAL.match(tok) or YEARISH.match(tok):
        return False
    if any(c.isdigit() for c in tok):
        return True
    return any(c.isupper() for c in tok[1:]) and any(c.islower() for c in tok)


def first_token(window):
    # A code almost always sits alone on its own line, which is a far stronger
    # signal than any character-class rule and is what lets an all-letters code
    # through without opening the door to ordinary prose.
    for line in window.splitlines():
        tok = line.strip()
        if 4 <= len(tok) <= 10 and tok.isalnum() and code_shaped(tok):
            return tok
    for m in TOKEN_RE.finditer(window):
        tok = m.group(1)
        if not plausible(tok):
            continue
        # Inside a URL, an email address or a filename: not a code.
        before = window[m.start() - 1] if m.start() else ' '
        after = window[m.end()] if m.end() < len(window) else ' '
        if before in '@/.=-_' or after in '@/=_':
            continue
        if NOISE.search(window[max(0, m.start() - 60):m.end() + 60]):
            continue
        return tok
    return None


URL_RE = re.compile(r'https?://[^\s<>"\')\]]+')


def extract_link(text, pattern):
    """Newest URL in `text` matching `pattern`, or None.

    Workday tenants do not all send a short code. Ciena (2026-08-12) mailed an
    activation LINK instead — plain text, no <a href> wrapper — which TOKEN_RE
    and LABEL_RE cannot see at all, so a run waiting for a code spun until it
    timed out on mail that had already arrived.

    A plaintext-rendered HTML part leaves artifacts glued to the end of the URL
    (a stray '<br>The' was the real case), so the match is trimmed at the first
    tag-ish or whitespace character and of trailing punctuation.
    """
    rx = re.compile(pattern, re.I)
    for m in URL_RE.finditer(text):
        url = m.group(0)
        url = re.split(r'<|&lt;|\s', url)[0].rstrip('.,;:)]}"\'')
        if rx.search(url):
            return url
    return None


def scan(host, port, user, pw, needle, since_min, verbose, loose=False,
         link_pattern=''):
    """Newest matching code (or URL, with link_pattern), or None.

    Read-only; nothing in the mailbox changes.
    """
    try:
        box = imaplib.IMAP4_SSL(host, port)
        box.login(user, pw)
    except imaplib.IMAP4.error as exc:
        sys.exit(f'get_code: IMAP login failed ({exc}) — is the app password still valid?')
    try:
        box.select('INBOX', readonly=True)
        # IMAP SINCE has date granularity only, so it cannot express "the last
        # 10 minutes". Ask for today and yesterday (a run crossing midnight is
        # otherwise blind), then filter on the real timestamp below.
        day = time.strftime('%d-%b-%Y', time.localtime(time.time() - 86400))
        typ, data = box.search(None, f'(SINCE {day})')
        if typ != 'OK':
            return None
        ids = data[0].split()
        cutoff = time.time() - since_min * 60
        for mid in reversed(ids[-60:]):            # newest first
            typ, raw = box.fetch(mid, '(RFC822)')
            if typ != 'OK' or not raw or not isinstance(raw[0], tuple):
                continue
            msg = email.message_from_bytes(raw[0][1])
            stamp = email.utils.parsedate_to_datetime(msg.get('Date', ''))
            if stamp and stamp.timestamp() < cutoff:
                break                              # everything older still is too
            frm = str(make_header(decode_header(msg.get('From', ''))))
            subj = str(make_header(decode_header(msg.get('Subject', ''))))
            if needle and needle.lower() not in f'{frm} {subj}'.lower():
                continue
            haystack = f'{subj}\n{body_text(msg)}'
            code = (extract_link(haystack, link_pattern) if link_pattern
                    else extract(haystack, loose))
            if code:
                if verbose:
                    print(f'get_code: from={frm!r} subject={subj!r}', file=sys.stderr)
                return code
        return None
    finally:
        try:
            box.logout()
        except imaplib.IMAP4.error:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='needle', default='',
                    help='substring that must appear in From or Subject')
    ap.add_argument('--since', type=int, default=10, help='minutes to look back')
    ap.add_argument('--wait', type=int, default=0, help='poll up to N seconds')
    ap.add_argument('--link', dest='link', default='',
                    help='return the newest URL matching this regex instead of a code '
                         r'(e.g. --link "myworkdayjobs\.com/.*/activate/")')
    ap.add_argument('--loose', action='store_true',
                    help='also accept an unlabelled digit run (noisy; see extract())')
    ap.add_argument('-v', '--verbose', action='store_true')
    a = ap.parse_args()

    host, port, user, pw = creds()
    deadline = time.time() + a.wait
    while True:
        code = scan(host, port, user, pw, a.needle, a.since, a.verbose, a.loose,
                    link_pattern=a.link)
        if code:
            print(code)
            return 0
        if time.time() >= deadline:
            print('get_code: no confirmation '
                  + ('link' if a.link else 'code') + ' found', file=sys.stderr)
            return 2
        time.sleep(10)


if __name__ == '__main__':
    sys.exit(main())
