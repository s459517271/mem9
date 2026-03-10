package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// HTTPRequestsTotal counts requests by method, route pattern, and status code.
	HTTPRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "mnemo",
			Name:      "http_requests_total",
			Help:      "Total number of HTTP requests.",
		},
		[]string{"method", "route", "status"},
	)

	// HTTPRequestDuration observes request latency by method and route pattern.
	HTTPRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "mnemo",
			Name:      "http_request_duration_seconds",
			Help:      "HTTP request duration in seconds.",
			Buckets:   prometheus.DefBuckets,
		},
		[]string{"method", "route"},
	)
)

// Middleware records HTTP request count and duration for each request.
// It uses the chi route pattern (e.g. /v1alpha1/mem9s/{tenantID}/memories)
// rather than the raw URL to avoid high cardinality from tenant IDs.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := chimw.NewWrapResponseWriter(w, r.ProtoMajor)

		next.ServeHTTP(ww, r)

		route := chi.RouteContext(r.Context()).RoutePattern()
		if route == "" {
			route = r.URL.Path
		}

		status := strconv.Itoa(ww.Status())
		duration := time.Since(start).Seconds()

		HTTPRequestsTotal.WithLabelValues(r.Method, route, status).Inc()
		HTTPRequestDuration.WithLabelValues(r.Method, route).Observe(duration)
	})
}
