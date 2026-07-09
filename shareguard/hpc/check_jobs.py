"""Check SLURM job status."""

import subprocess
import sys


def check_slurm_jobs(job_name: str = None):
    """Check status of SLURM jobs.

    Args:
        job_name: Filter by job name. If None, show all user's jobs.
    """
    cmd = ["squeue", "-u", subprocess.getoutput("whoami"), "--format=%.18i %.9P %.30j %.8T %.10M %.6D %R"]

    if job_name:
        cmd.extend(["--name", job_name])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        print(result.stdout)
        if result.stderr:
            print(f"stderr: {result.stderr}", file=sys.stderr)
    except FileNotFoundError:
        print("squeue not found. Are you on an HPC system with SLURM?")


def check_gpu_availability():
    """Check GPU availability across partitions."""
    try:
        result = subprocess.run(["sinfo", "-o", "%P %G %A"], capture_output=True, text=True)
        print("Partition GPU Availability:")
        print(result.stdout)
    except FileNotFoundError:
        print("sinfo not found.")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Check SLURM jobs")
    parser.add_argument("--name", type=str, default=None, help="Filter by job name")
    parser.add_argument("--gpu", action="store_true", help="Show GPU availability")
    args = parser.parse_args()

    if args.gpu:
        check_gpu_availability()
    else:
        check_slurm_jobs(args.name)


if __name__ == "__main__":
    main()
