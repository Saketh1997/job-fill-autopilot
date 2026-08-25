#!/usr/bin/env python3
import json
import re
import yaml

# Load title filter
with open('portals.yml', 'r') as f:
    config = yaml.safe_load(f)

positive = set(config['title_filter']['positive'])
negative = set(config['title_filter']['negative'])
boost = set(config['title_filter']['seniority_boost'])

# Load API results
with open('anthropic.json', 'r') as f:
    api_data = json.load(f)

# Dedup history
seen_urls = set()
with open('/home/hunter/.hermes/Job_Scraper/dedup/scan-history.tsv', 'r') as f:
    for line in f:
        if line.startswith('timestamp'): continue
        seen_urls.add(line.split('\t')[1])

def is_match(title):
    title_lower = title.lower()
    # Negative must NOT match
    if any(neg.lower() in title_lower for neg in negative):
        return False
    # At least one positive must match
    if not any(pos.lower() in title_lower for pos in positive):
        return False
    return True

results = []
for job in api_data.get('jobs', []):
    title = job.get('title', '').strip()
    url = job.get('absolute_url', '').strip()
    if not url or url in seen_urls:
        continue
    if is_match(title):
        results.append({
            'company': 'Anthropic',
            'title': title,
            'url': url,
            'source': 'api',
            'query_name': 'Anthropic'
        })

print(json.dumps(results, indent=2))