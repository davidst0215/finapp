import { cn } from '@/lib/utils';

interface UserAvatarProps {
  name?: string | null;
  imageUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
  verified?: boolean;
  className?: string;
}

const sizeClasses = {
  sm: 'w-9 h-9 text-sm',
  md: 'w-11 h-11 text-base',
  lg: 'w-16 h-16 text-xl',
};

const badgeSizes = {
  sm: 16,
  md: 20,
  lg: 26,
};

export function UserAvatar({ name, imageUrl, size = 'md', verified = false, className }: UserAvatarProps) {
  const initials = name
    ? name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : 'U';

  return (
    <div className={cn('relative inline-flex', className)}>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={name ?? 'Avatar'}
          className={cn('rounded-full object-cover', sizeClasses[size])}
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className={cn(
          'rounded-full flex items-center justify-center font-bold',
          'bg-primary-600/20 border border-primary-600/30 text-primary-400',
          sizeClasses[size],
        )}>
          {initials}
        </div>
      )}

      {verified && (
        <span className="absolute -end-1 -top-1">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={badgeSizes[size]}
            height={badgeSizes[size]}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              className="fill-slate-950"
              d="M3.046 8.277A4.402 4.402 0 0 1 8.303 3.03a4.4 4.4 0 0 1 7.411 0 4.397 4.397 0 0 1 5.19 3.068c.207.713.23 1.466.067 2.19a4.4 4.4 0 0 1 0 7.415 4.403 4.403 0 0 1-3.06 5.187 4.398 4.398 0 0 1-2.186.072 4.398 4.398 0 0 1-7.422 0 4.398 4.398 0 0 1-5.257-5.248 4.4 4.4 0 0 1 0-7.437Z"
            />
            <path
              fill="rgb(var(--slate-100))"
              d="M4.674 8.954a3.602 3.602 0 0 1 4.301-4.293 3.6 3.6 0 0 1 6.064 0 3.598 3.598 0 0 1 4.3 4.302 3.6 3.6 0 0 1 0 6.067 3.6 3.6 0 0 1-4.29 4.302 3.6 3.6 0 0 1-6.074 0 3.598 3.598 0 0 1-4.3-4.293 3.6 3.6 0 0 1 0-6.085Z"
            />
            <path
              className="fill-slate-950"
              d="M15.707 9.293a1 1 0 0 1 0 1.414l-4 4a1 1 0 0 1-1.414 0l-2-2a1 1 0 1 1 1.414-1.414L11 12.586l3.293-3.293a1 1 0 0 1 1.414 0Z"
            />
          </svg>
        </span>
      )}
    </div>
  );
}
