package afu

import (
	"math"
	"strings"
	"testing"
	"time"
)

const weightSample = "ac298069117002000540000a000000000029d51b"
const adcSample = "ac29020001f401c20180691170000000000029d60f"

func TestSyntheticPackets(t *testing.T) {
	w, e := Parse(weightSample, 0xd5)
	if e != nil || w.WeightGrams != 70000 || !w.Stable {
		t.Fatalf("%+v %v", w, e)
	}
	a, e := Parse(adcSample, 0xd6)
	if e != nil || a.WeightGrams != 70000 || len(a.ADCs) != 2 || a.ADCs[0] != 500 || a.ADCs[1] != 450 {
		t.Fatalf("%+v %v", a, e)
	}
}
func TestTwentyByteADCWrapper(t *testing.T) {
	raw := adcSample[:34] + adcSample[36:]
	a, e := Parse(raw, 0xd6)
	if e != nil || a.WeightGrams != 70000 || a.ADCs[0] != 500 {
		t.Fatalf("%+v %v", a, e)
	}
}
func TestLiveWeightIsNotLocked(t *testing.T) {
	live := weightSample[:4] + "00" + weightSample[6:]
	p, err := Parse(live, 0xd5)
	if err != nil || p.Stable || p.WeightGrams != 70000 {
		t.Fatalf("live D5 mistaken for locked result: %+v %v", p, err)
	}
}
func TestMalformedPackets(t *testing.T) {
	for _, s := range []string{"", "zz", weightSample[:36], "d5" + weightSample[2:], strings.Replace(weightSample, "d51b", "d81b", 1)} {
		if _, e := Parse(s, 0xd5); e == nil {
			t.Fatal("accepted malformed packet")
		}
	}
	for _, s := range []string{adcSample[:40], strings.Replace(adcSample, "2902", "2905", 1), weightSample} {
		if _, e := Parse(s, 0xd6); e == nil {
			t.Fatal("accepted malformed ADC")
		}
	}
}
func TestEstimatesAndMissingInputs(t *testing.T) {
	at := time.Date(2026, 10, 17, 4, 0, 0, 0, time.UTC)
	p := Person{Sex: "male", HeightCM: 170, BirthDate: "1990-10-18"}
	r := Calculate(70000, []int{456, 407}, 0, p, &at)
	// Independent numeric oracle for the reference Segal branch, age 35.
	ffm := 9.33285 + 0.00066360*170*170 - 0.02117*456 + 0.62854*70.0 - 0.12380*35
	expected := math.Round(100*(70.0-ffm)/70.0*100) / 100
	if r.Status != "estimated" || r.Age != 35 || r.BodyFatPct != expected || r.AlgorithmVersion != AlgorithmVersion {
		t.Fatalf("%+v expected %v", r, expected)
	}
	for _, adcs := range [][]int{nil, {0, 407}, {30000, 407}} {
		r = Calculate(70000, adcs, 0, p, &at)
		if r.BodyFatPct != 0 || r.Status != "missing_adc" || r.BMI != 0 {
			t.Fatalf("invented missing estimate %+v", r)
		}
	}
	r = Calculate(70000, []int{456, 407}, 0, Person{}, &at)
	if r.Status != "missing_profile" || r.BodyFatPct != 0 {
		t.Fatal(r)
	}
	r = Calculate(70000, []int{456, 407}, 0, p, nil)
	if r.Status != "invalid_time" || r.BodyFatPct != 0 {
		t.Fatal(r)
	}
	r = Calculate(70000, []int{456, 407}, 1, p, &at)
	if r.Resistance != 407 || r.ADCIndex != 1 {
		t.Fatal(r)
	}
	if Normalize(2000, 60.6) != 126.27 {
		t.Fatal(Normalize(2000, 60.6))
	}
}

func TestMonthPrecisionAge(t *testing.T) {
	at := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	p := Person{Sex: "male", HeightCM: 170, BirthMonth: "1990-10"}
	approximate := Calculate(70000, []int{500}, 0, p, &at)
	if approximate.Status != "estimated" || !approximate.AgeApproximate || approximate.Age != 36 {
		t.Fatal(approximate)
	}
	p.BirthDate = "1990-10-18"
	exact := Calculate(70000, []int{500}, 0, p, &at)
	if exact.AgeApproximate || exact.Age != 35 {
		t.Fatal(exact)
	}
	at = time.Date(2026, 9, 30, 15, 59, 0, 0, time.UTC)
	p.BirthDate = ""
	if got := Calculate(70000, []int{500}, 0, p, &at); got.Age != 35 {
		t.Fatal(got)
	}
}
