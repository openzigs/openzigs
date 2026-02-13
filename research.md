# 3-node Medium Kubernetes Cluster Pricing Comparison

Date: 2026-02-12

## Executive Summary
This report compares estimated monthly and hourly costs for a 3-node "medium" managed Kubernetes cluster on AWS (EKS), GCP (GKE), and Azure (AKS). Each provider calculation uses a representative "medium" worker instance type, 100 GB persistent storage per node, 100 GB/month egress, and 730 hours per month. Summary on-demand monthly estimates:

- AWS (EKS, 3 × m6i.large, 100 GB gp3/node): ~ $303 / month
- GCP (GKE, 3 × c4-standard-4, 100 GB PD/node): ~ $523 / month (on‑demand)
- Azure (AKS, 3 × Standard_D4s_v3, 100 GB Premium SSD P10/node): ~ $480 / month

Note: discounts (reserved/committed/spot) materially reduce VM costs — examples shown below.

---

## Assumptions (common)
- Region: AWS us-east-1, GCP us-central1, Azure eastus.
- Month = 730 hours (used for hourly → monthly conversion).
- Linux OS for worker nodes.
- 3 worker nodes, each with a "medium" size chosen per provider (see per‑provider choice below).
- Storage: 100 GB per node (rounded to nearest managed-disk SKU where needed).
- Network egress: 100 GB/month to internet (we assume this falls in free or minimal bucket for these regions as noted).
- No additional managed add-ons (load balancers, NAT gateways, logging/monitoring charges beyond default), and no support or taxes included.

---

## Detailed per-provider breakdown

### AWS — EKS (us-east-1)
- "Medium" node chosen: m6i.large (2 vCPU, 8 GiB).
- EKS control plane: $0.10/hr = $72 / month.
- EC2 on-demand: $0.096/hr / node → $69.12 / month / node → $207.36 / month (3 nodes).
- EBS gp3 (100 GB/node): $0.08/GB/month → $8 / month / node → $24 / month (3 nodes).
- Data egress: first 100 GB/month free.
- Total (on-demand): ~ $207.36 (EC2) + $24 (EBS) + $72 (EKS control plane) = ~$303 / month.

Discounts / alternatives:
- Savings Plans / Reserved Instances: ~40% off compute typically — EC2 portion can fall to roughly $123/month (for 3 nodes) depending on term and payment option.
- Spot instances: big savings (40–90% lower than on-demand) but preemptible.

Sources: EKS pricing, EC2 on-demand, EBS pricing, Spot docs.

---

### GCP — GKE (us-central1)
- "Medium" node chosen: c4-standard-4 (4 vCPU, 15 GiB) as representative medium.
- GKE control plane: $0.10/hr → $72 / month.
- Compute (on-demand): $0.19767/hr → $142.32 / month / node → $426.96 / month (3 nodes).
- Persistent Disk (100 GB/node): $0.04/GB/month → $4 / month / node → $12 / month (3 nodes).
- Data egress: 100 GB @ ~$0.12/GB → ~$12 / month (first 100 GB may be free depending on region/account; agent counted $12 in some sources — see source details below).
- Total (on-demand): VM $426.96 + PD $12 + control plane $72 + egress $12 = **~ $522.96 / month**.

Discounts / alternatives:
- Committed Use Discounts (1yr/3yr) can reduce VM costs substantially (1yr and 3yr examples reduced totals to ~$403/month and ~$327/month respectively in the agent's calculations).
- Preemptible / short-term instances: large discounts but increased eviction risk.

Sources: GKE pricing, Compute Engine pricing, Disk pricing, Network pricing.

---

### Azure — AKS (eastus)
- "Medium" node chosen: Standard_D4s_v3 (4 vCPU, 16 GiB) as representative medium.
- AKS control plane: assumed free for the common (free) management tier (nodes are billed separately).
- VM PAYG: ~$0.192 / hr → $140.16 / month / node → $420.48 / month (3 nodes).
- Managed Disk: Premium SSD P10 (representative 100GB SKU): ~$19.71 / month / disk → $59.13 / month (3 nodes).
- Network egress: first 100 GB/month in North America often falls in a free/low-cost bracket; agent assumed $0 for first 100GB.
- Total (PAYG): $420.48 + $59.13 = **~ $479.61 / month**.

Discounts / alternatives:
- 1‑year / 3‑year Reservations (Reserved Instances) can reduce monthly VM cost heavily (an example 1‑yr reservation example reduced effective VM monthly to ~$83.58 per node equivalent; a 3‑node reserved cluster monthly example came to roughly ~$310/month + storage).
- Spot VMs can reduce VM cost substantially (example spot run gave ~ $211/month total but with eviction risk).
- Azure Hybrid Benefit / Savings Plans and reservations can further lower costs for eligible customers.

Sources: Azure Retail Prices API, AKS pricing pages, managed disk pricing, bandwidth pricing.

---

## Comparison Table (on-demand baseline)

| Provider | Worker type (example) | Worker cost (3 nodes / month) | Storage (3×100GB / month) | Control plane / month | Egress 100GB | Total / month (on-demand) |
|---|---:|---:|---:|---:|---:|---:|
| AWS (EKS) | 3 × m6i.large | $207.36 | $24 | $72 | free | $303 |
| GCP (GKE) | 3 × c4-standard-4 | $426.96 | $12 | $72 | $12 | $522.96 |
| Azure (AKS) | 3 × D4s_v3 | $420.48 | $59.13 | $0 | free | $479.61 |

Notes: per‑provider VM selections differ (vCPU / RAM profile) — choose instance family aligned to your workload for accurate apples-to-apples comparison.

---

## Discount & Preemptible Options (illustrative)
- AWS: Savings Plans / Reserved Instances → ~30–40% off compute; Spot → up to 70–90% off but preemptible.
- GCP: Committed Use Discounts → large savings (1yr/3yr). Preemptible VMs → deep discounts but ephemeral.
- Azure: Reserved Instances / Savings Plans / Azure Hybrid Benefit → large savings; Spot VMs → deep discounts with eviction.

Example quick comparisons (illustrative, not exhaustive):
- AWS on‑demand ~$303/mo → with EC2 savings plans/reservations might go to roughly ~$200 or less depending on term and coverage; spot for worker nodes could reduce to ~$60–$100/mo for 3 nodes (volatile).
- GCP on‑demand ~$523/mo → 1yr CUD example reduced to ~$403/mo; 3yr CUD example to ~$327/mo.
- Azure on‑demand ~$480/mo → 1yr reservation example reduced to ~$310/mo (depends on reservation amortization and payment option); spot ~ $211/mo in one example.

---

## Recommendations & Notes
1. Define the workload profile (CPU/memory/IO) precisely and pick equivalent instance families across providers to make a true apples-to-apples comparison (examples used here are representative, not exact feature matches).
2. For sustained production clusters, use reserved/committed pricing (1 or 3 year) to get large savings; for dev/test, consider spot/preemptible with a mixed node pool and fallback on-demand nodes.
3. Include additional services in any final estimate: managed load balancers, NAT gateways, logging/monitoring, snapshots, and backup — these add nontrivial costs.
4. Negotiate enterprise discounts / use committed spend or cloud provider marketplace agreements where possible.

---

## Full Citations / Useful Links
- AWS: EKS pricing, EC2 on‑demand pricing, EBS pricing, EC2 Spot pricing
  - https://aws.amazon.com/eks/pricing/
  - https://aws.amazon.com/ec2/pricing/on-demand/
  - https://aws.amazon.com/ebs/pricing/
  - https://aws.amazon.com/ec2/spot/pricing/

- GCP: GKE pricing, Compute Engine pricing, Persistent Disk pricing, Network pricing
  - https://cloud.google.com/kubernetes-engine/pricing
  - https://cloud.google.com/compute/all-pricing
  - https://cloud.google.com/compute/disks-image-pricing
  - https://cloud.google.com/vpc/network-pricing

- Azure: AKS pricing, Azure retail prices API, managed disks, bandwidth
  - https://azure.microsoft.com/en-us/pricing/details/kubernetes-service/
  - https://prices.azure.com/
  - https://azure.microsoft.com/en-us/pricing/details/managed-disks/
  - https://azure.microsoft.com/en-us/pricing/details/bandwidth/

---

## Appendix: Agent-derived assumptions & quick math
- AWS numbers used: m6i.large at $0.096/hr, EKS control plane $0.10/hr, gp3 @ $0.08/GB-month.
- GCP numbers used: c4-standard-4 at $0.19767/hr, PD $0.04/GB-month, GKE control plane $0.10/hr.
- Azure numbers used: Standard_D4s_v3 at ~$0.192/hr, Premium SSD P10 ~ $19.71/month per 100GB-disk, AKS control plane assumed free.
- All hourly→monthly = hourly * 730.

---

If desired, next steps:
- Recompute with a consistent compute profile (e.g., 2 vCPU / 8 GiB across all providers) for strict apples-to-apples comparison.
- Add typical additional services (1 load balancer, central logging, snapshots) to estimate TCO.
- Produce CSV or machine-readable breakdown for cost-tracking.


(Report generated by automated multi-agent research; verify prices on the provider pricing pages or APIs before committing budget.)
