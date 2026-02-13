# Cloud Pricing Comparison: 3-node "Medium" Kubernetes Cluster

Date: 2026-02-12

Cluster assumptions
- 3 worker nodes
- Each node: 4 vCPU / 16 GB RAM (m5.xlarge / n2-standard-4 / Standard_D4s_v3 equivalents)
- Linux, on-demand (pay-as-you-go)
- 100 GB persistent disk per node (300 GB total)
- 100 GB outbound network egress/month
- 1 external Application/Standard Load Balancer
- Hours per month: 730
- Regions used: AWS us-east-1, GCP us-central1, Azure eastus

---

## Side-by-side monthly cost summary

| Line item / Cloud      | AWS (us-east-1) | GCP (us-central1) - Zonal | Azure (eastus) |
|------------------------|-----------------|---------------------------:|----------------:|
| Control plane          | $73.00          | $0.00 (zonal) / $73.00 (regional) | $0.00          |
| Compute (3 nodes)      | $420.48         | $473.04                   | $420.48         |
| Storage (300 GB)       | $24.00          | $51.00                    | $40.80          |
| Network egress (100GB) | $9.00           | $12.00                    | $0.00           |
| Load balancer          | $22.27          | $18.25                    | $18.25          |
| **Estimated Total**    | **$548.75**     | **$554.29** (zonal) / **$627.29** (regional) | **$479.53** |

Notes: GCP regional control plane adds ~$73/mo if chosen; totals shown reflect that.

---

## Breakdown & sources (by provider)

### AWS (EKS) — estimate: $548.75/month
- EKS control plane: $0.10/hr → $73.00/mo
- EC2 m5.xlarge (on-demand): $0.192/hr → 3 × 0.192 × 730 = $420.48/mo
- EBS gp3: $0.08/GB-mo → 300 GB = $24.00/mo
- Data egress: ~$0.09/GB → 100 GB = $9.00/mo
- ALB: approx $22.27/mo
- Sources: https://aws.amazon.com/eks/pricing/ , https://aws.amazon.com/ec2/pricing/on-demand/ , https://aws.amazon.com/ebs/pricing/ , https://aws.amazon.com/elasticloadbalancing/pricing/

### GCP (GKE) — estimate: $554.29/mo (zonal) / $627.29/mo (regional)
- GKE control plane: zonal clusters free; regional control plane ~$0.10/hr ($73/mo)
- n2-standard-4: ~$0.216/hr → 3 × 0.216 × 730 = $473.04/mo
- PD-SSD: ~$0.17/GB-mo → 300 GB = $51.00/mo
- Network egress: ~$0.12/GB → 100 GB = $12.00/mo
- Load balancer: ~$18.25/mo
- Sources: https://cloud.google.com/kubernetes-engine/pricing , https://cloud.google.com/compute/all-pricing , https://cloud.google.com/network-pricing#internet_egress

### Azure (AKS) — estimate: $479.53/month
- AKS control plane: free (no control-plane charge for standard AKS management)
- Standard_D4s_v3: ~$0.192/hr → 3 × 0.192 × 730 = $420.48/mo
- Managed Premium SSD ~100 GB: ~$13.60/mo each → 3 × = $40.80/mo
- Outbound bandwidth: first 100 GB often free or negligible in small tiers → $0
- Load balancer: ~$18.25/mo
- Sources: https://azure.microsoft.com/en-us/pricing/details/kubernetes-service/ , https://azure.microsoft.com/en-us/pricing/details/managed-disks/ , https://azure.microsoft.com/en-us/pricing/details/load-balancer/

---

## Key assumptions & caveats
- All prices are on-demand (no discounts, no committed use/reserved instances, no sustained-use discounts).
- Regions chosen as common US regions; prices vary by region.
- Instance type choices aim to match 4 vCPU / 16 GB RAM; different families or series will change costs.
- Storage performance (gp3, PD-SSD, Premium SSD) and snapshot/IOPS charges excluded beyond base cost.
- Network pricing is simplified (only simple internet egress included); multi-AZ / cross-region traffic or heavy ingress/load-balancer processing will increase costs.
- Managed control-plane pricing policies change; GKE has free zonal clusters but charges for autopilot/regional; AKS historically free but verify latest docs.

---

## Recommendation (one-paragraph)
For a straightforward, on-demand 3-node medium cluster the raw monthly cost differences are modest: Azure appears least expensive (~$480/mo) in this configuration primarily because AKS control plane and the first 100 GB egress are free; AWS and GCP are roughly comparable (AWS ~$549, GCP ~$554 zonal). Operational considerations (regional availability, managed features, support, enterprise discounts, sustained-use/committed savings, and existing cloud commitments) typically outweigh the small monthly delta; pick the provider aligned with your team's tooling and discount opportunities, and consider reserved instances / committed use to cut compute costs significantly.

---

If you want, next steps can include: 1) recalculating with a different instance class (e.g., burstable or ARM-based), 2) adding autoscaling and spot/preemptible scenarios, or 3) modelling 1-year reserved / committed-use discounts to show TCO.
