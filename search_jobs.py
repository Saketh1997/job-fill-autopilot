#!/usr/bin/env python3

import yaml
import json
import subprocess
import re

# Load portals.yml for title filter
with open('portals.yml', 'r') as f:
    config = yaml.safe_load(f)

# Extract title filter
positive_keywords = config['title_filter']['positive']
negative_keywords = config['title_filter']['negative']

# Compile regex patterns
positive_pattern = re.compile('|'.join(map(re.escape, positive_keywords)), re.IGNORECASE)
negative_pattern = re.compile('|'.join(map(re.escape, negative_keywords)), re.IGNORECASE)

# Load queries
with open('queries.json', 'r') as f:
    queries = json.load(f)

# Run WebSearch for each query
results = []
dedup_keys = set()
for query in queries:
    print(f"Searching: {query['name']}")
    try:
        # Run WebSearch via Hermes CLI
        search_output = subprocess.check_output([
            "hermes", "chat", "-q", f"WebSearch '{query['query']}' --max-results=10 --output=json"
        ], stderr=subprocess.PIPE, text=True)
        
        # Parse JSON output
        search_data = json.loads(search_output.strip())
        
        # Filter results
        for item in search_data:
            title = item.get('title', '')
            url = item.get('url', '')
            
            # Skip if no title or URL
            if not title or not url:
                continue
                
            # Check title filter
            if positive_pattern.search(title) and not negative_pattern.search(title):
                # Check dedup
                dedup_key = f"{title.lower()}|{url.lower()}"
                if dedup_key not in dedup_keys:
                    dedup_keys.add(dedup_key)
                    results.append({
                        'title': title,
                        'url': url,
                        'source': query['name'],
                        'query': query['query']
                    })
                
    except Exception as e:
        print(f"Error searching {query['name']}: {e}")

# Save results
with open('job_results.json', 'w') as f:
    json.dump(results, f, indent=2)

print(f"Found {len(results)} jobs.")