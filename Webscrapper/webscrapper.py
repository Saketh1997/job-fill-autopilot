import requests
import json
import re
import sys
from bs4 import BeautifulSoup
import time as tm
from itertools import groupby
from datetime import datetime, timedelta, time
from urllib.parse import quote
import csv


def load_config(file_name):
    # Load the config file
    with open(file_name) as f:
        return json.load(f)


def get_with_retry(url, config, retries=3, delay=1):
    # Get the URL with retries and delay
    for i in range(retries):
        try:
            if len(config.get('proxies', [])) > 0:
                r = requests.get(url, headers=config['headers'], proxies=config['proxies'], timeout=5)
            else:
                r = requests.get(url, headers=config['headers'], timeout=5)
            return BeautifulSoup(r.content, 'html.parser')
        except requests.exceptions.Timeout:
            print(f"Timeout occurred for URL: {url}, retrying in {delay}s...")
            tm.sleep(delay)
        except Exception as e:
            print(f"An error occurred while retrieving the URL: {url}, error: {e}")
    return None


def transform(soup):
    # Parse the job card info (title, company, location, date, job_url) from the BeautifulSoup object
    joblist = []
    try:
        divs = soup.find_all('div', class_='base-search-card__info')
    except Exception as e:
        print("Empty page, no jobs found")
        return joblist
    for item in divs:
        title = item.find('h3').text.strip() if item.find('h3') else ''
        company_tag = item.find('a', class_='hidden-nested-link')
        company = company_tag.text.strip().replace('\n', ' ') if company_tag else ''
        location_tag = item.find('span', class_='job-search-card__location')
        location = location_tag.text.strip() if location_tag else ''
        parent_div = item.parent
        entity_urn = parent_div.get('data-entity-urn', '')
        job_posting_id = entity_urn.split(':')[-1] if entity_urn else ''
        job_url = f'https://www.linkedin.com/jobs/view/{job_posting_id}/' if job_posting_id else ''

        date_tag_new = item.find('time', class_='job-search-card__listdate--new')
        date_tag = item.find('time', class_='job-search-card__listdate')
        date = ''
        if date_tag and date_tag.has_attr('datetime'):
            date = date_tag['datetime']
        elif date_tag_new and date_tag_new.has_attr('datetime'):
            date = date_tag_new['datetime']

        job = {
            'title': title,
            'company': company,
            'location': location,
            'date': date,
            'job_url': job_url,
            'job_description': '',
            'fit_score': 0,
            'applied': 0,
            'hidden': 0,
            'interview': 0,
            'rejected': 0
        }
        joblist.append(job)
    return joblist


def transform_job(soup):
    div = soup.find('div', class_='description__text description__text--rich')
    if div:
        # Remove unwanted elements
        for element in div.find_all(['span', 'a']):
            element.decompose()
        # Replace bullet points
        for ul in div.find_all('ul'):
            for li in ul.find_all('li'):
                li.insert(0, '-')
        text = div.get_text(separator='\n').strip()
        text = text.replace('\n\n', '')
        text = text.replace('::marker', '-')
        text = text.replace('-\n', '- ')
        text = text.replace('Show less', '').replace('Show more', '')
        return text
    else:
        return "Could not find Job Description"


_WORD_NUMS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
              "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12}

# "3+ years", "2-4 yrs", "three (3) years", "5 to 7 years", "two years' experience"
_YEARS_RE = re.compile(
    r"(?:(?P<w>one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
    r"|(?P<n>\d{1,2}))"
    r"\s*(?:\(\d{1,2}\))?"
    r"\s*(?:\+|plus)?"
    r"\s*(?:[-–—~]|to)?\s*\d{0,2}\s*\+?"
    r"\s*(?:years?|yrs?)\b(?P<tail>[^.;\n]{0,60})",
    re.I)

# a year-count only counts as a requirement if experience-ish words appear near it
_EXP_CTX_RE = re.compile(
    r"experience|exp\b|professional|industry|relevant|hands.on|working"
    r"|work\b|track record|in a similar|employment|background", re.I)

_NO_EXP_RE = re.compile(
    r"no (?:prior |previous )?(?:work |industry |professional )?"
    r"experience (?:required|needed|necessary)", re.I)


def extract_required_years(text):
    """Return the minimum years-of-experience a job description asks for.

    None  -> the description never asks for years of experience
    0     -> explicitly entry-level ("0-2 years", "no experience required")
    N > 0 -> asks for at least N years (lower bound of any range/"N+" mention)

    Takes the minimum across mentions so "3+ years ML, 1+ year Python" reads
    as a 1-year floor, and ignores year-counts with no experience context
    nearby ("founded 12 years ago", "24 years old").
    """
    if not text:
        return None
    if _NO_EXP_RE.search(text):
        return 0
    reqs = []
    for m in _YEARS_RE.finditer(text):
        pre = text[max(0, m.start() - 60):m.start()]
        if not (_EXP_CTX_RE.search(m.group("tail") or "") or _EXP_CTX_RE.search(pre)):
            continue
        lo = _WORD_NUMS[m.group("w").lower()] if m.group("w") else int(m.group("n"))
        if lo > 30:  # "founded 40 years ago" style noise
            continue
        reqs.append(lo)
    return min(reqs) if reqs else None


def requires_experience(text, max_years=0):
    """True if the description demands more than ``max_years`` of experience."""
    yrs = extract_required_years(text)
    return yrs is not None and yrs > max_years


def safe_detect(text):
    # Simply assume the language is English to remove dependency on langdetect
    return 'en'


def score_fit(job, config):
    """Score a job 0..N for how well it fits the candidate's profile/portfolio.

    The score rewards three independent signals, so a role only needs to be a
    *strong fit on one axis* (high acceptance probability OR portfolio-aligned)
    to survive the ``min_fit_score`` cutoff:

    - early-career framing in the title (new grad / entry / intern / associate)
    - the title being one of the target archetypes (ML/Data/Infra/SWE...)
    - the description name-dropping the candidate's portfolio tech (PostgreSQL
      internals, k3s, RAG/LLM, CUDA, data pipelines, ...)

    Title-only signals still score in cards-only mode (no description fetched);
    portfolio keywords add precision once descriptions are available.
    """
    title = job.get('title', '').lower()
    desc = job.get('job_description', '').lower()

    score = 0
    # +2 if the title is explicitly framed as early-career (best acceptance odds)
    if any(sig.lower() in title for sig in config.get('early_career_signals', [])):
        score += 2
    # +2 if the title matches one of the target archetypes
    if any(t.lower() in title for t in config.get('priority_titles', [])):
        score += 2
    # +1 per distinct portfolio keyword in the description, capped at +4
    hits = sum(1 for kw in config.get('portfolio_keywords', []) if kw.lower() in desc)
    score += min(hits, 4)
    return score


def remove_irrelevant_jobs(joblist, config):
    # Filter out jobs based on description, title, and language from the config.
    new_joblist = [job for job in joblist
                   if not any(word.lower() in job['job_description'].lower() for word in config.get('desc_words', []))]
    if config.get('title_exclude'):
        new_joblist = [job for job in new_joblist
                       if not any(word.lower() in job['title'].lower() for word in config['title_exclude'])]
    if config.get('title_include'):
        new_joblist = [job for job in new_joblist
                       if any(word.lower() in job['title'].lower() for word in config['title_include'])]
    if config.get('languages'):
        new_joblist = [job for job in new_joblist
                       if safe_detect(job['job_description']) in config['languages']]
    if config.get('company_exclude'):
        new_joblist = [job for job in new_joblist
                       if not any(word.lower() in job['company'].lower() for word in config['company_exclude'])]

    # Positive fit filter: keep only jobs the candidate has a real shot at /
    # that exercise the portfolio, then rank best-fit first.
    min_fit = config.get('min_fit_score', 0)
    for job in new_joblist:
        job['fit_score'] = score_fit(job, config)
    new_joblist = [job for job in new_joblist if job['fit_score'] >= min_fit]
    new_joblist.sort(key=lambda j: j['fit_score'], reverse=True)
    return new_joblist


def remove_duplicates(joblist, config):
    # Remove duplicate jobs (duplicates have the same title and company)
    joblist.sort(key=lambda x: (x['title'], x['company']))
    joblist = [next(g) for k, g in groupby(joblist, key=lambda x: (x['title'], x['company']))]
    return joblist


def convert_date_format(date_string):
    """
    Converts a date string (expected format YYYY-MM-DD) to a date object.
    """
    date_format = "%Y-%m-%d"
    try:
        job_date = datetime.strptime(date_string, date_format).date()
        return job_date
    except ValueError:
        return None


def scrape_cards(config, fetch_descriptions=False, verbose=False):
    """Scrape LinkedIn guest job-search pages and return a flat, de-duplicated
    list of job card dicts (title, company, location, date, job_url, ...).

    Cards-only by default for speed -- per-job description fetching is left to
    the evaluation stage. Iterates every keyword x location, paginates until a
    page returns no cards (cheap when ``timespan`` is short), and drops jobs
    older than ``days_to_scrape``. Network/parse failures degrade to an empty
    page rather than raising, so a partial scan still returns what it found.
    """
    all_jobs = []
    seen = set()
    rounds = config.get('rounds', 1)
    pages = config.get('pages_to_scrape', 1)
    timespan = config.get('timespan', '86400')
    page_delay = config.get('page_delay', 0.5)
    # LinkedIn experience-level filter (f_E): 1=Internship 2=Entry 3=Associate
    # 4=Mid-Senior 5=Director 6=Executive. Default to early-career band.
    exp = str(config.get('experience_levels', '1,2,3'))
    cutoff = datetime.now() - timedelta(days=config.get('days_to_scrape', 7))

    for _ in range(rounds):
        for query in config.get('search_queries', []):
            keywords = query.get('keywords', [])
            locations = query.get('location', []) or ['United States']
            f_wt = query.get('f_WT', '')
            for keyword in keywords:
                for location in locations:
                    for i in range(pages):
                        url = (
                            "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
                            f"?f_E={quote(exp)}&keywords={quote(keyword)}&location={quote(location)}"
                            f"&f_WT={f_wt}&geoId=&f_TPR={timespan}&start={30 * i}"
                        )
                        soup = get_with_retry(url, config)
                        if soup is None:
                            break
                        cards = transform(soup)
                        if not cards:
                            break  # no more results (or rate-limited) for this keyword/location
                        new_on_page = 0
                        for job in cards:
                            if not job['job_url']:
                                continue
                            key = (job['title'].lower(), job['company'].lower(), job['job_url'])
                            if key in seen:
                                continue
                            jd = convert_date_format(job['date'])
                            if jd is not None and datetime.combine(jd, time()) < cutoff:
                                continue
                            seen.add(key)
                            all_jobs.append(job)
                            new_on_page += 1
                        if verbose:
                            print(f"[linkedin] {keyword} @ {location} p{i}: +{new_on_page} (total {len(all_jobs)})")
                        tm.sleep(page_delay)

    if fetch_descriptions:
        for job in all_jobs:
            desc_soup = get_with_retry(job['job_url'], config)
            job['job_description'] = transform_job(desc_soup) if desc_soup else "Could not retrieve job description"
            tm.sleep(page_delay)

    return all_jobs


def write_csv(filename, joblist):
    if not joblist:
        print(f"No records to write for {filename}.")
        return
    for job in joblist:
        job.setdefault('date_loaded', datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    headers = list(joblist[0].keys())
    with open(filename, "w+", newline="", encoding="utf-8") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=headers)
        writer.writeheader()
        for job in joblist:
            writer.writerow(job)
    print(f"Written {len(joblist)} records to {filename}.")


def main(config_file):
    """Standalone CLI: scrape, fetch descriptions, apply config filters, write CSVs."""
    start_time = tm.perf_counter()
    config = load_config(config_file)

    job_list = scrape_cards(config, fetch_descriptions=True, verbose=True)
    jobs_to_add = remove_irrelevant_jobs(job_list, config)
    filtered_list = [job for job in job_list if job not in jobs_to_add]
    print(f"Total jobs scraped: {len(job_list)} | kept: {len(jobs_to_add)} | filtered out: {len(filtered_list)}")

    write_csv('linkedin_jobs.csv', jobs_to_add)
    write_csv('linkedin_jobs_filtered.csv', filtered_list)

    end_time = tm.perf_counter()
    print(f"Scraping finished in {end_time - start_time:.2f} seconds")


if __name__ == "__main__":
    config_file = 'config.json'  # default config file
    if len(sys.argv) == 2:
        config_file = sys.argv[1]
    main(config_file)
